#!/usr/bin/env node
import { containerAppTargetArgs, revisionListArgs } from "./webhook-empty-state-azure-target.mjs"
import { probeRootRuntime } from "./webhook-empty-state-runtime.mjs"
import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync, unlinkSync } from "node:fs"
import { pathToFileURL } from "node:url"
import {
  readPolicy,
  readAuthorization,
  readRootFile,
  atomicRootWrite,
  runDirectory,
  FENCE,
  checkParents,
} from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import {
  advancePhase,
  verifyCompletionProof,
  releaseOwnedMaintenance,
  replayPhaseOutput,
  PHASES,
} from "./webhook-empty-state-phases.mjs"
import {
  canonical,
  sha256,
  validateReceipt,
  validateAuthorization,
  requireValue,
  REPOSITORY,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"

const RESOURCE_ROOT =
  "/subscriptions/b2f8f58b-18f5-4e49-ac53-06ea04ff0f4c/resourceGroups/LyraShieldAI/providers/"
const RESOURCES = {
  app: RESOURCE_ROOT + "Microsoft.App/containerApps/lyrashield-app",
  scanner: RESOURCE_ROOT + "Microsoft.App/containerApps/lyrashield-scanner",
  worker: RESOURCE_ROOT + "Microsoft.Compute/virtualMachines/lyrashield-worker",
}
const BUNDLE = "/opt/lyrashield-worker-host"
const WORKER_ENV = "/etc/lyrashield/worker.env"
const MIGRATION_ENV = "/etc/lyrashield/webhook-empty-state.env"
export const PRODUCTION_CUTOVER_ENABLED = false
function run(program, args, json = false, timeout = 60_000) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2_000_000,
    env: { PATH: "/usr/bin:/bin", HOME: "/root" },
  })
  requireValue(result.status === 0, "Fixed evidence acquisition failed")
  return json ? JSON.parse(result.stdout) : result.stdout.trim()
}
function secureEnv(path) {
  checkParents(path)
  const stat = lstatSync(path)
  requireValue(
    !stat.isSymbolicLink() &&
      stat.isFile() &&
      stat.uid === 0 &&
      (stat.mode & 0o777) === 0o600 &&
      stat.nlink === 1,
    "Unsafe fixed environment file"
  )
}
function pinnedImage(image) {
  requireValue(
    /^ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-worker@sha256:[a-f0-9]{64}$/.test(
      image || ""
    ),
    "Unapproved worker image reference"
  )
}
export function validateRootTargets(policy) {
  for (const name of ["app", "scanner", "worker"])
    requireValue(
      policy.resources[name]?.toLowerCase() === RESOURCES[name].toLowerCase(),
      "Unapproved target resource"
    )
  requireValue(
    policy.resources.system === policy.resources.worker &&
      policy.resources.migration === "migration" &&
      policy.resources.backup === "backup",
    "Unapproved database role resources"
  )
  for (const name of ["candidate", "fallback", "observer", "stopped"])
    pinnedImage(policy.images[name])
  requireValue(
    policy.principalObjectId === "b08289b5-8229-47bf-9d2f-7a8fcea7dfc1",
    "Wrong approved deployment principal"
  )
  requireValue(
    sha256(readFileSync(BUNDLE + "/ops/worker/webhook-empty-state-producer.mjs")) ===
      policy.producerSha256,
    "Producer source changed"
  )
}
function containerProbe(policy, owner, observedAt, externalOnly = false) {
  secureEnv(WORKER_ENV)
  secureEnv(MIGRATION_ENV)
  pinnedImage(policy.images.observer)
  const args = [
    "run",
    "--rm",
    "--network",
    "bridge",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--env-file",
    WORKER_ENV,
    "--env-file",
    MIGRATION_ENV,
    "--env",
    "TMPDIR=/tmp",
    "--volume",
    `${BUNDLE}:/app/packages/db/empty-state:ro`,
    "-w",
    "/app/apps/worker",
    policy.images.observer,
    "node",
    "--import",
    "tsx",
    "/app/packages/db/empty-state/ops/worker/webhook-empty-state-observer.mjs",
    externalOnly ? "worker-external" : "worker",
    policy.resources.worker,
    observedAt,
    owner,
  ]
  return run("/usr/bin/docker", args, true)
}
export function appConnectionProbeSource(resourceId, observedAt) {
  return `import {createHash} from 'node:crypto';
    const raw=process.env.DATABASE_URL; if(!raw||raw.length>8192)throw Error('missing');
    const u=new URL(raw), keys=[...u.searchParams.keys()];
    if(!['postgres:','postgresql:'].includes(u.protocol)||u.hash||u.pathname!='/postgres'||(u.searchParams.get('schema')||'public')!=='public'||new Set(keys).size!==keys.length||keys.some(k=>!['schema','sslmode'].includes(k))||u.searchParams.get('sslmode')!=='verify-full')throw Error('unsafe');
    let ref,principal;const direct=u.hostname.match(/^db\\.([a-z0-9]{20})\\.supabase\\.co$/i), user=decodeURIComponent(u.username);
    if(direct&&/^[a-z_][a-z0-9_$]{0,62}$/.test(user)&&(!u.port||u.port==='5432')){ref=direct[1];principal=user;}
    else if(/\\.pooler\\.supabase\\.com$/i.test(u.hostname)&&['','5432','6543'].includes(u.port)){const p=user.match(/^([a-z_][a-z0-9_$]{0,62})\\.([a-z0-9]{20})$/i);if(p&&p[1]===p[1].toLowerCase()){principal=p[1];ref=p[2];}}
    if(!ref||!principal)throw Error('unbound');const h=v=>createHash('sha256').update(v).digest('hex');
    console.log(JSON.stringify({identitySha256:h(JSON.stringify({provider:'supabase',projectRef:ref.toLowerCase(),database:'postgres',schema:'public'})),principalSha256:h(principal),credentialSha256:h(raw),resourceId:${JSON.stringify(resourceId)},observedAt:${JSON.stringify(observedAt)}}));`
}
function appConnection(policy, name, observedAt) {
  // This is a readback from the actual runtime, not a host-only URL hash or
  // schema similarity. exec404/missing module/readback fails closed.
  const code = appConnectionProbeSource(policy.resources[name], observedAt)
  const quoted = "'" + code.replaceAll("'", "'\"'\"'") + "'"
  const result = run(
    "/usr/bin/az",
    [
      "containerapp",
      "exec",
      ...containerAppTargetArgs(policy.resources[name]),
      "--command",
      "node --input-type=module -e " + quoted,
    ],
    false
  )
  const lines = result.split("\n").filter((line) => line.startsWith("{"))
  requireValue(lines.length === 1, "Runtime connection readback unavailable")
  return JSON.parse(lines[0])
}
function revisionInventory(resourceId) {
  const revisions = run("/usr/bin/az", revisionListArgs(resourceId), true)
  requireValue(
    Array.isArray(revisions) &&
      revisions.length > 0 &&
      revisions.every((revision) => Number.isSafeInteger(revision.replicas)),
    "Incomplete revision/replica inventory"
  )
  return { resourceId, revisions }
}
function imageProof(image) {
  pinnedImage(image)
  return {
    imageDigest: image.split("@")[1],
    sourceSha: run("/usr/bin/docker", [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      image,
    ]),
    engineRevision: run("/usr/bin/docker", [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "io.lyrashield.engine.revision"}}',
      image,
    ]),
  }
}
function proveRun(runId, sourceSha, workflowPath) {
  const record = run("/usr/bin/gh", ["api", `repos/${REPOSITORY}/actions/runs/${runId}`], true)
  requireValue(
    record.conclusion === "success" &&
      record.head_sha === sourceSha &&
      record.path === workflowPath &&
      String(record.repository?.id) === "1286618458",
    "Evidence workflow did not succeed on exact source"
  )
}
export function collectReceipt(policy, authorization, originalConnections, priorEvidence) {
  const observedAt = new Date().toISOString()
  // Parent and SQL state read directly, including soft-deleted rows. Never
  // receive caller counts, JSON, verified flags, command or trust-root inputs.
  const observations = containerProbe(
    policy,
    authorization.owner,
    observedAt,
    Boolean(priorEvidence)
  )
  const fence = readRootFile(FENCE)
  requireValue(
    canonical(fence.authorization) === canonical(authorization),
    "Startup fence is foreign"
  )
  const inventory = ["app", "scanner"].map((name) => revisionInventory(policy.resources[name]))
  const stopped = imageProof(policy.images.stopped)
  const serviceState = run("/usr/bin/systemctl", [
    "show",
    "--property=ActiveState",
    "--value",
    "lyrashield-worker.service",
  ])
  const timerState = run("/usr/bin/systemctl", [
    "show",
    "--property=ActiveState",
    "--value",
    "lyrashield-worker-egress-refresh.timer",
  ])
  const workerNames = run("/usr/bin/docker", [
    "ps",
    "--filter",
    "name=^/lyrashield-worker$",
    "--format",
    "{{.Names}}",
  ])
  const worker = {
    ...stopped,
    serviceState,
    timerState,
    containers: workerNames ? workerNames.split("\n").length : 0,
    stopOwner: authorization.owner,
    stopAt: observedAt,
    startupFenced: true,
  }
  worker.stopProofSha256 = sha256(canonical(worker))
  for (const name of ["candidate", "fallback"]) {
    const image = imageProof(policy.images[name])
    requireValue(
      Object.entries(image).every(([key, value]) => policy[name][key] === value),
      "Candidate/fallback image labels changed"
    )
    proveRun(
      policy[name].rehearsalRunId,
      policy[name].sourceSha,
      ".github/workflows/verify-webhook-worker-image.yml"
    )
  }
  // Backup/restore proof is immutable root-owned output from the exact-object
  // acquisition path. It must also match successful authenticated workflow runs.
  const backup = readRootFile(`${runDirectory(policy.runId)}/backup.json`),
    restore = readRootFile(`${runDirectory(policy.runId)}/restore.json`)
  proveRun(backup.runId, policy.backupSourceSha, ".github/workflows/production-backup.yml")
  proveRun(restore.runId, policy.backupSourceSha, ".github/workflows/production-backup.yml")
  const database = {
    ...observations.database,
    app: originalConnections.app,
    scanner: originalConnections.scanner,
  }
  const receipt = {
    schemaVersion: "webhook-empty-state/v3",
    mode: "empty-scheduling",
    authorization,
    evidence: {
      ...priorEvidence,
      observedAt,
      ...observations,
      database,
      writers: inventory,
      worker,
      candidate: policy.candidate,
      fallback: policy.fallback,
      backup,
      restore,
    },
  }
  validateReceipt(receipt, policy)
  return receipt
}
export function validateProducerRequest(args, policy) {
  const [phase, runId, attempt, sourceSha, nonce, ...extra] = args
  requireValue(
    !extra.length &&
      [
        "preflight",
        "admission",
        "drain",
        "stop",
        "collect",
        "migrate",
        "complete",
        "candidate",
        "resume",
        "continuity-external",
      ].includes(phase) &&
      /^[1-9][0-9]{0,5}$/.test(attempt || "") &&
      Number(attempt) >= policy.originalAttempt &&
      runId === policy.runId &&
      sourceSha === policy.sourceSha &&
      nonce === policy.nonce,
    "Unbounded or foreign producer request"
  )
  return { phase, runId, attempt: Number(attempt) }
}
function observerCommand(policy, script, args = []) {
  pinnedImage(policy.images.observer)
  secureEnv(WORKER_ENV)
  secureEnv(MIGRATION_ENV)
  return run("/usr/bin/docker", [
    "run",
    "--rm",
    "--network",
    script === "webhook-empty-state-observer.mjs" && args[0] === "runtime" ? "none" : "bridge",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--env-file",
    WORKER_ENV,
    "--env-file",
    MIGRATION_ENV,
    "--volume",
    `${BUNDLE}:/app/packages/db/empty-state:ro`,
    "-w",
    "/app/apps/worker",
    policy.images.observer,
    "node",
    "--import",
    "tsx",
    `/app/packages/db/empty-state/ops/worker/${script}`,
    ...args,
  ])
}
function assertDrained(observations) {
  requireValue(
    observations.nonterminalScans === 0 && observations.inFlightHandlers === 0,
    "Existing work must drain normally"
  )
  for (const queue of Object.values(observations.queues))
    requireValue(
      Object.values(queue.counts).every((count) => count === 0) &&
        queue.schedulers === 0 &&
        queue.repeats === 0,
      "Latent queue work or schedulers"
    )
}
async function main() {
  requireValue(
    PRODUCTION_CUTOVER_ENABLED,
    "Production root producer remains disabled pending reviewed integration and owner setup"
  )
  const policy = readPolicy()
  validateRootTargets(policy)
  const request = validateProducerRequest(process.argv.slice(2), policy),
    authorization = readAuthorization(policy)
  validateAuthorization(authorization, readPolicy())
  const directory = runDirectory(request.runId),
    statePath = `${directory}/progress.json`
  let state
  try {
    state = readRootFile(statePath)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (request.phase === "continuity-external") {
    const prior = readRootFile(`${directory}/receipt.json`)
    validateReceipt(prior, readPolicy())
    const receipt = collectReceipt(
      policy,
      authorization,
      readRootFile(`${directory}/connections.json`),
      prior.evidence
    )
    validateReceipt(receipt, readPolicy())
    process.stdout.write("EMPTY_STATE_LIVE_CONTINUITY_MATCH\n")
    return
  }
  // Replayed workflow steps skip only durable, already completed phases. The
  // original authorization remains fixed and current policy is revalidated.
  if (state && request.phase !== "resume" && PHASES.indexOf(request.phase) <= PHASES.indexOf(state.phase)) {
    const receipt =
      PHASES.indexOf(state.phase) >= PHASES.indexOf("collect")
        ? readRootFile(`${directory}/receipt.json`)
        : undefined
    process.stdout.write(
      replayPhaseOutput(request.phase, state, authorization, readPolicy(), receipt)
    )
    return
  }
  const planned = advancePhase(state, request.phase, authorization, policy)
  // Admission value is deterministic from original authorization, preserved on
  // retries. Its owner never changes to a later workflow attempt.
  const stop = canonical({
    operator: "github-actions",
    reason: "webhook-empty-state",
    owner: authorization.owner,
    runId: authorization.runId,
    sourceSha: authorization.sourceSha,
    nonceSha256: sha256(authorization.nonce),
    at: authorization.issuedAt,
  })
  requireValue(sha256(stop) === policy.admissionValueSha256, "Approved admission value changed")
  if (request.phase !== "preflight" && request.phase !== "admission" && request.phase !== "resume")
    observerCommand(policy, "webhook-empty-state-admission.mjs", ["assert", stop])
  if (request.phase === "preflight") {
    // Reject an incomplete root installation before claiming admission.
    probeRootRuntime(policy)
    const observedAt = new Date().toISOString()
    const runtime = observerCommand(policy, "webhook-empty-state-observer.mjs", [
      "runtime",
      policy.resources.worker,
      observedAt,
      "preflight",
    ])
    requireValue(
      JSON.parse(runtime).runtime === "EMPTY_STATE_OBSERVER_RUNTIME_MATCH",
      "Pinned observer import graph unavailable before admission"
    )
    const connections = Object.fromEntries(
      ["app", "scanner"].map((name) => [name, appConnection(policy, name, observedAt)])
    )
    for (const name of ["app", "scanner"])
      requireValue(
        connections[name].identitySha256 === policy.databaseIdentitySha256 &&
          connections[name].principalSha256 === sha256(policy.databasePrincipals[name]) &&
          connections[name].credentialSha256 === policy.credentials[name],
        "Runtime connection differs from approved identity"
      )
    for (const name of ["candidate", "fallback"]) {
      imageProof(policy.images[name])
      proveRun(
        policy[name].rehearsalRunId,
        policy[name].sourceSha,
        ".github/workflows/verify-webhook-worker-image.yml"
      )
    }
    run("/usr/bin/node", [BUNDLE + "/ops/worker/webhook-empty-state-backup-proof.mjs"])
    const backup = readRootFile(`${directory}/backup.json`),
      restore = readRootFile(`${directory}/restore.json`)
    requireValue(
      canonical(backup) === canonical(policy.backup) &&
        canonical(restore) === canonical(policy.restore) &&
        restore.backupSha256 === sha256(canonical(backup)),
      "Exact backup/restore acquisition missing"
    )
    proveRun(backup.runId, policy.backupSourceSha, ".github/workflows/production-backup.yml")
    proveRun(restore.runId, policy.backupSourceSha, ".github/workflows/production-backup.yml")
    atomicRootWrite(`${directory}/connections.json`, connections)
  } else if (request.phase === "admission") {
    observerCommand(policy, "webhook-empty-state-admission.mjs", ["claim", stop])
  } else if (request.phase === "drain") {
    assertDrained(containerProbe(policy, authorization.owner, new Date().toISOString()))
  } else if (request.phase === "stop") {
    assertDrained(containerProbe(policy, authorization.owner, new Date().toISOString()))
    // Fence is durable before any writer is stopped, protecting reboots between
    // phases. Stop every active old revision, including zero-traffic URLs.
    atomicRootWrite(FENCE, {
      schemaVersion: "webhook-empty-state-fence/v2",
      authorization,
      state: "stopped",
    })
    for (const name of ["app", "scanner"]) {
      for (const revision of revisionInventory(policy.resources[name]).revisions.filter(
        (value) => value.active
      )) {
        requireValue(/^[a-z0-9-]{1,128}$/.test(revision.name), "Invalid observed revision identity")
        run("/usr/bin/az", [
          "containerapp",
          "revision",
          "deactivate",
          ...containerAppTargetArgs(policy.resources[name]),
          "--revision",
          revision.name,
          "--only-show-errors",
        ])
      }
    }
    for (const unit of [
      "lyrashield-worker-egress-refresh.timer",
      "lyrashield-worker-egress-refresh.service",
      "lyrashield-worker.service",
    ])
      run("/usr/bin/systemctl", ["stop", unit])
    for (const unit of ["lyrashield-worker-egress-refresh.timer", "lyrashield-worker.service"])
      run("/usr/bin/systemctl", ["disable", unit])
  } else if (request.phase === "collect") {
    const receipt = collectReceipt(
      policy,
      authorization,
      readRootFile(`${directory}/connections.json`)
    )
    atomicRootWrite(`${directory}/receipt.json`, receipt)
    process.stdout.write(sha256(canonical(receipt)) + "\n")
  } else if (request.phase === "migrate") {
    // Trusted runner reads fixed root files, official attestation and the
    // identical validated direct/session URL aliases. No PEM/caller JSON path.
    run(
      "/usr/bin/node",
      [BUNDLE + "/ops/worker/webhook-empty-state-run-migration.mjs"],
      false,
      1_200_000
    )
  } else if (request.phase === "complete") {
    const result = readRootFile(`${directory}/migration-result.json`),
      receipt = readRootFile(`${directory}/receipt.json`)
    validateReceipt(receipt, readPolicy())
    verifyCompletionProof(result.completion, receipt, result)
    atomicRootWrite(`${directory}/completion.json`, result.completion)
    atomicRootWrite(FENCE, {
      schemaVersion: "webhook-empty-state-fence/v2",
      authorization,
      state: "migration-complete",
      receiptSha256: sha256(canonical(receipt)),
      completionSha256: sha256(canonical(result.completion)),
    })
  } else if (request.phase === "candidate") {
    // Candidate promotion is deliberately delegated to the fixed reviewed
    // forward-only helper. It may not start any consumer without the fence proof.
    run("/usr/bin/node", [BUNDLE + "/ops/worker/webhook-empty-state-candidate.mjs"], false, 900_000)
  } else if (request.phase === "resume") {
    requireValue(
      readRootFile(`${directory}/candidate-ready.json`).authorizationSha256 ===
        sha256(canonical(authorization)),
      "Candidate readiness proof missing"
    )
    validateAuthorization(authorization, readPolicy())
    const intentPath = `${directory}/release-intent.json`
    let intent
    try {
      intent = readRootFile(intentPath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (!intent) {
      observerCommand(policy, "webhook-empty-state-admission.mjs", ["assert", stop])
      intent = {
        authorizationSha256: sha256(canonical(authorization)),
        stopSha256: sha256(stop),
        completionSha256: readRootFile(`${directory}/candidate-ready.json`).completionSha256,
      }
      atomicRootWrite(intentPath, intent)
    }
    requireValue(
      intent.authorizationSha256 === sha256(canonical(authorization)) &&
        intent.stopSha256 === sha256(stop),
      "Foreign release intent"
    )
    let heldFence
    try {
      heldFence = readRootFile(FENCE)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (!heldFence) {
      const completion = readRootFile(`${directory}/completion.json`),
        receipt = readRootFile(`${directory}/receipt.json`)
      requireValue(
        sha256(canonical(completion)) === intent.completionSha256,
        "Release recovery completion changed"
      )
      heldFence = {
        schemaVersion: "webhook-empty-state-fence/v2",
        authorization,
        state: "migration-complete",
        receiptSha256: sha256(canonical(receipt)),
        completionSha256: intent.completionSha256,
      }
    }
    requireValue(
      canonical(heldFence.authorization) === canonical(authorization),
      "Foreign startup fence before release"
    )
    await releaseOwnedMaintenance({
      release: () =>
        observerCommand(policy, "webhook-empty-state-admission.mjs", ["release-retry", stop]),
      checkPublicReadiness: () => {
        const ready = run("/usr/bin/curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "15",
          "https://app.lyrashieldai.com/api/ready/scans",
        ])
        requireValue(
          ready === '{"status":"ready","checks":{"worker":true}}',
          "Public scan readiness failed after owned release"
        )
      },
      recheckAuthorization: () => validateAuthorization(authorization, readPolicy()),
      persistCompletion: () =>
        atomicRootWrite(statePath, { ...planned, lastAttempt: request.attempt }),
      cleanupOwnedFence: () => {
        try {
          requireValue(
            canonical(readRootFile(FENCE).authorization) === canonical(authorization),
            "Foreign startup fence"
          )
          unlinkSync(FENCE)
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
      },
      restoreOwnedHold: () => {
        observerCommand(policy, "webhook-empty-state-admission.mjs", ["claim", stop])
        try {
          requireValue(
            canonical(readRootFile(FENCE).authorization) === canonical(authorization),
            "Foreign fence during re-hold"
          )
        } catch (error) {
          if (error.code !== "ENOENT") throw error
          atomicRootWrite(FENCE, heldFence)
        }
      },
    })
    process.stdout.write("EMPTY_STATE_PHASE_COMPLETE=resume\n")
    return
  }
  validateAuthorization(authorization, readPolicy())
  atomicRootWrite(statePath, { ...planned, lastAttempt: request.attempt })
  process.stdout.write(`EMPTY_STATE_PHASE_COMPLETE=${request.phase}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Fixed empty-state producer failed; retain maintenance\n")
    process.exitCode = 1
  })
}
