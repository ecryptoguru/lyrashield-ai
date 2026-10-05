#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import {
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  constants,
  lstatSync,
} from "node:fs"
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
  requireValue,
  canonical,
  sha256,
  validateAuthorization,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { validateStartupProof } from "./webhook-empty-state-startup-fence.mjs"
import { collectPreparedCandidateFingerprint } from "./webhook-empty-state-candidate-connection.mjs"
const ENABLED = false
function run(program, args, json = false) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1_000_000,
    env: { PATH: "/usr/bin:/bin", HOME: "/root" },
  })
  requireValue(result.status === 0, "Candidate promotion failed; retain maintenance")
  return json ? JSON.parse(result.stdout) : result.stdout.trim()
}
try {
  requireValue(ENABLED, "Candidate adapter remains disabled")
  const policy = readPolicy(),
    authorization = readAuthorization(policy),
    directory = runDirectory(policy.runId)
  const fence = readRootFile(FENCE),
    proof = readRootFile(`${directory}/completion.json`)
  validateStartupProof(fence, proof, policy, policy.images.candidate)
  validateAuthorization(authorization, readPolicy())
  // No legacy rollback is implemented: all mutations are forward-only and
  // admission remains owned/stopped until both candidate resources and worker
  // prove readiness on the completed additive schema.
  const candidateConnections = Object.fromEntries(
    ["app", "scanner"].map((name) => [name, collectPreparedCandidateFingerprint(policy, name)])
  )
  atomicRootWrite(`${directory}/candidate-connections.json`, candidateConnections)
  for (const name of ["app", "scanner"]) {
    const revision = policy.candidateRevisions?.[name]
    requireValue(
      /^[a-z0-9-]{1,128}$/.test(revision || ""),
      "Exact prepared candidate revision missing"
    )
    const resource = run(
      "/usr/bin/az",
      [
        "containerapp",
        "revision",
        "show",
        "--ids",
        policy.resources[name],
        "--revision",
        revision,
        "-o",
        "json",
      ],
      true
    )
    requireValue(
      resource.properties?.template?.containers?.length === 1 &&
        resource.properties.template.containers[0].image === policy.images[name],
      "Candidate revision image changed"
    )
    run("/usr/bin/az", [
      "containerapp",
      "revision",
      "activate",
      "--ids",
      policy.resources[name],
      "--revision",
      revision,
      "--only-show-errors",
    ])
    run("/usr/bin/az", [
      "containerapp",
      "ingress",
      "traffic",
      "set",
      "--ids",
      policy.resources[name],
      "--revision-weight",
      `${revision}=100`,
      "--only-show-errors",
    ])
    validateAuthorization(authorization, readPolicy())
  }
  const config = "/etc/lyrashield/worker-runtime.conf"
  checkParents(config)
  const stat = lstatSync(config)
  requireValue(
    !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o777) === 0o600,
    "Unsafe worker config"
  )
  const saved = readFileSync(config, "utf8")
  requireValue(/^LYRASHIELD_WORKER_IMAGE=.+$/m.test(saved), "Worker image configuration missing")
  const updated = saved.replace(
    /^LYRASHIELD_WORKER_IMAGE=.+$/m,
    `LYRASHIELD_WORKER_IMAGE=${policy.images.candidate}`
  )
  const temporary = config + ".empty-state.tmp"
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    writeFileSync(fd, updated)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, config)
  for (const unit of ["lyrashield-worker.service", "lyrashield-worker-egress-refresh.timer"]) {
    run("/usr/bin/systemctl", ["enable", unit])
    run("/usr/bin/systemctl", ["start", unit])
  }
  requireValue(
    run("/usr/bin/docker", ["inspect", "--format", "{{.Config.Image}}", "lyrashield-worker"]) ===
      policy.images.candidate,
    "Running worker image changed"
  )
  requireValue(
    run("/usr/bin/docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      "lyrashield-worker",
    ]) === "healthy",
    "Admission-independent worker health unavailable"
  )
  requireValue(
    run("/usr/bin/docker", [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      policy.images.candidate,
    ]) === policy.candidate.sourceSha,
    "Candidate worker source changed"
  )
  const databaseReady = run("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "https://app.lyrashieldai.com/api/ready",
  ])
  requireValue(
    databaseReady === '{"status":"ready","checks":{"database":true,"redis":true}}',
    "Admission-independent app readiness unavailable"
  )
  validateAuthorization(authorization, readPolicy())
  atomicRootWrite(`${directory}/candidate-ready.json`, {
    authorizationSha256: sha256(canonical(authorization)),
    completionSha256: sha256(canonical(proof)),
    observedAt: new Date().toISOString(),
  })
} catch {
  process.stderr.write("Fixed candidate adapter failed; retain maintenance\n")
  process.exitCode = 1
}
