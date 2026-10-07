import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import {
  assertPostReleaseProbe,
  assertPostReleaseRunHistory,
} from "./verify-webhook-post-release-finalization.mjs"

// One incident, one historical owner. This entry has no generic receipt adoption.
const ORIGINAL = Object.freeze({
  runId: "37516632066",
  owner: "37516632066:1",
  sourceSha: "af2b7a5acf34cf23a6577181de92e8d010f0beb2",
})
const SHA = /^[a-f0-9]{40}$/
const ID = /^[1-9][0-9]*$/
const REVISION = /^[a-zA-Z0-9_.-]+$/
const REPOSITORY = "ecryptoguru/lyrashield-ai"
const FINALIZER_WORKFLOW = ".github/workflows/finalize-held-webhook-recovery.yml"

function fail() {
  throw new Error("Incident finalization proof failed; no further revisions will be activated")
}

function command(program, args, timeout = 120_000) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: "True" },
  })
  if (result.error?.code === "ETIMEDOUT" || [124, 137].includes(result.status)) {
    throw new Error("AMBIGUOUS_REMOTE_TIMEOUT")
  }
  if (result.error || result.status !== 0 || !result.stdout) fail()
  return result.stdout
}

function jsonCommand(program, args, timeout) {
  try {
    return JSON.parse(command(program, args, timeout))
  } catch (error) {
    if (error?.message === "AMBIGUOUS_REMOTE_TIMEOUT") throw error
    fail()
  }
}

function context(env = process.env) {
  const historical = {
    runId: env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID,
    attempt: env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT,
    sourceSha: env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA,
  }
  const current = {
    runId: env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_RUN_ID,
    attempt: env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_ATTEMPT,
    sourceSha: env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_SOURCE_SHA,
  }
  const workerImage = env.LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WORKER_IMAGE
  const webImage = env.LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WEB_IMAGE
  const engineRevision = env.LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_ENGINE_REVISION
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID !== ORIGINAL.runId ||
    env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER !== ORIGINAL.owner ||
    env.LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA !== ORIGINAL.sourceSha ||
    !ID.test(historical.runId ?? "") ||
    !ID.test(historical.attempt ?? "") ||
    !SHA.test(historical.sourceSha ?? "") ||
    !ID.test(current.runId ?? "") ||
    !ID.test(current.attempt ?? "") ||
    !SHA.test(current.sourceSha ?? "") ||
    new Set([ORIGINAL.runId, historical.runId, current.runId]).size !== 3 ||
    current.runId !== env.GITHUB_RUN_ID ||
    current.attempt !== env.GITHUB_RUN_ATTEMPT ||
    current.sourceSha !== env.DEPLOY_SHA ||
    !SHA.test(engineRevision ?? "") ||
    !new RegExp(`^ghcr\\.io/${REPOSITORY}/lyrashield-worker@sha256:[a-f0-9]{64}$`).test(
      workerImage ?? ""
    ) ||
    !new RegExp(`^ghcr\\.io/${REPOSITORY}/lyrashield-web@sha256:[a-f0-9]{64}$`).test(
      webImage ?? ""
    ) ||
    !REVISION.test(env.RG ?? "") ||
    !REVISION.test(env.WORKER_VM_NAME ?? "") ||
    !REVISION.test(env.APP_NAME ?? "") ||
    !REVISION.test(env.SCANNER_NAME ?? "") ||
    env.APP_NAME === env.SCANNER_NAME ||
    env.APP_URL !== "https://app.lyrashieldai.com" ||
    env.SCANNER_URL !== "https://scanner.lyrashieldai.com"
  )
    fail()
  return {
    historical,
    current,
    workerImage,
    webImage,
    engineRevision,
    rg: env.RG,
    vm: env.WORKER_VM_NAME,
    app: env.APP_NAME,
    scanner: env.SCANNER_NAME,
  }
}

function gh(path) {
  return jsonCommand("gh", ["api", `repos/${REPOSITORY}/${path}`])
}

function verifyGithub(ctx, closure = false) {
  const source = command("git", ["rev-parse", "HEAD"]).trim()
  const branch = closure ? null : gh("git/ref/heads/main")?.object?.sha
  const current = gh(
    `actions/runs/${ctx.current.runId}${closure ? `/attempts/${ctx.current.attempt}` : ""}`
  )
  if (
    source !== ctx.current.sourceSha ||
    (!closure && branch !== ctx.current.sourceSha) ||
    current?.id !== Number(ctx.current.runId) ||
    current.run_attempt !== Number(ctx.current.attempt) ||
    current.head_sha !== ctx.current.sourceSha ||
    current.head_branch !== "main" ||
    ![
      FINALIZER_WORKFLOW,
      `${FINALIZER_WORKFLOW}@main`,
      `${FINALIZER_WORKFLOW}@refs/heads/main`,
    ].includes(current.path) ||
    current.event !== "workflow_dispatch" ||
    !(closure
      ? ["queued", "in_progress"].includes(current.status) ||
        (current.status === "completed" && ["failure", "cancelled"].includes(current.conclusion))
      : ["queued", "in_progress"].includes(current.status))
  )
    fail()
  const original = gh(`actions/runs/${ORIGINAL.runId}/attempts/${ORIGINAL.owner.split(":")[1]}`)
  const recovery = gh(`actions/runs/${ctx.historical.runId}/attempts/${ctx.historical.attempt}`)
  assertPostReleaseRunHistory(original, recovery, {
    originalRunId: ORIGINAL.runId,
    originalOwner: ORIGINAL.owner,
    originalSourceSha: ORIGINAL.sourceSha,
    recoveryRunId: ctx.historical.runId,
    recoveryAttempt: ctx.historical.attempt,
    recoverySourceSha: ctx.historical.sourceSha,
  })
}

function vmPhase(ctx, phase) {
  const args = [
    phase,
    ctx.historical.sourceSha,
    `${ctx.historical.runId}:${ctx.historical.attempt}`,
    ctx.historical.runId,
    "",
    ctx.historical.attempt,
    ORIGINAL.runId,
    ORIGINAL.sourceSha,
    ORIGINAL.owner,
    ctx.historical.runId,
    ctx.historical.attempt,
    ctx.historical.sourceSha,
    ctx.current.runId,
    ctx.current.attempt,
    ctx.current.sourceSha,
    ctx.workerImage,
    ctx.webImage,
  ]
  const payload = readFileSync(".github/scripts/webhook-claims-vm.sh").toString("base64")
  const envLib = readFileSync("ops/worker/worker-env.sh").toString("base64")
  // All arguments above are validated closed-form identifiers or pinned refs.
  const script = `set -eu; directory=$(mktemp -d /var/lib/lyrashield/webhook-claims-run.XXXXXX); trap 'rm -rf "$directory"' EXIT; printf '%s' '${envLib}' | base64 -d > "$directory/worker-env.sh"; printf '%s' '${payload}' | base64 -d > "$directory/cutover.sh"; LYRASHIELD_WORKER_ENV_LIB="$directory/worker-env.sh" timeout --kill-after=2s 120s sh "$directory/cutover.sh" ${args.map((value) => `'${value}'`).join(" ")}`
  const value = jsonCommand(
    "az",
    [
      "vm",
      "run-command",
      "invoke",
      "--name",
      ctx.vm,
      "--resource-group",
      ctx.rg,
      "--command-id",
      "RunShellScript",
      "--scripts",
      script,
      "--output",
      "json",
    ],
    180_000
  )?.value?.[0]?.message
  if (typeof value !== "string" || value.length > 100_000) fail()
  return value
}

function markerOnce(output, key, value) {
  const lines = output.split(/\r?\n/)
  const matches = lines.filter((line) => line.startsWith(`${key}=`))
  if (matches.length !== 1 || matches[0] !== `${key}=${value}`) fail()
}

function markerValue(output, key, pattern) {
  const matches = output.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`))
  if (matches.length !== 1) fail()
  const value = matches[0].slice(key.length + 1)
  if (!pattern.test(value)) fail()
  return value
}

function verifyProbe(ctx, output) {
  assertPostReleaseProbe(output, {
    originalOwner: ORIGINAL.owner,
    recoveryRunId: ctx.historical.runId,
    recoveryAttempt: ctx.historical.attempt,
    recoverySourceSha: ctx.historical.sourceSha,
    workerImage: ctx.workerImage,
    webImage: ctx.webImage,
  })
  for (const [key, value] of [
    ["WEBHOOK_POST_RELEASE_FINALIZER_RUN_ID", ctx.current.runId],
    ["WEBHOOK_POST_RELEASE_FINALIZER_ATTEMPT", ctx.current.attempt],
    ["WEBHOOK_POST_RELEASE_FINALIZER_SOURCE_SHA", ctx.current.sourceSha],
    ["WEBHOOK_POST_RELEASE_ENGINE_REVISION", ctx.engineRevision],
  ])
    markerOnce(output, key, value)
  const states = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("WEBHOOK_POST_RELEASE_RECEIPT_STATE="))
  if (
    states.length !== 1 ||
    !["release-intent", "released", "completed"].includes(states[0].split("=")[1])
  )
    fail()
  const auditState = markerValue(output, "WEBHOOK_POST_RELEASE_AUDIT_STATE", /^(?:absent|present)$/)
  if (
    auditState === "absent" &&
    output.split(/\r?\n/).some((line) => line.startsWith("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_"))
  )
    fail()
  if (auditState === "present") {
    const runId = markerValue(output, "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_RUN_ID", ID)
    const attempt = markerValue(output, "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_ATTEMPT", ID)
    const sourceSha = markerValue(output, "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_SOURCE_SHA", SHA)
    if ([ORIGINAL.runId, ctx.historical.runId].includes(runId)) fail()
    const run = gh(`actions/runs/${runId}/attempts/${attempt}`)
    if (
      run?.id !== Number(runId) ||
      run.run_attempt !== Number(attempt) ||
      run.head_sha !== sourceSha ||
      run.head_branch !== "main" ||
      ![
        FINALIZER_WORKFLOW,
        `${FINALIZER_WORKFLOW}@main`,
        `${FINALIZER_WORKFLOW}@refs/heads/main`,
      ].includes(run.path) ||
      run.event !== "workflow_dispatch" ||
      !["queued", "in_progress", "completed"].includes(run.status) ||
      (runId !== ctx.current.runId && run.status !== "completed")
    )
      fail()
  }
  return states[0].split("=")[1]
}

function provedReceiptState(ctx) {
  try {
    return verifyProbe(ctx, vmPhase(ctx, "postrelease-probe"))
  } catch {
    throw new Error("RECEIPT_STATE_UNKNOWN")
  }
}

export function selectExactRevision(revisions, image, allowForeignActive = false) {
  if (
    !Array.isArray(revisions) ||
    revisions.length === 0 ||
    revisions.some(
      (revision) => revision?.properties?.active !== false && revision?.properties?.active !== true
    ) ||
    revisions.some((revision) => !REVISION.test(revision?.name ?? ""))
  )
    fail()
  const matches = revisions.filter((revision) => {
    const containers = revision?.properties?.template?.containers
    return Array.isArray(containers) && containers.length === 1 && containers[0]?.image === image
  })
  if (
    matches.length !== 1 ||
    !REVISION.test(matches[0]?.name ?? "") ||
    (!allowForeignActive &&
      revisions.some(
        (revision) => revision.properties.active === true && revision.name !== matches[0].name
      ))
  )
    fail()
  return matches[0].name
}

function revisions(ctx, name) {
  return jsonCommand("az", [
    "containerapp",
    "revision",
    "list",
    "--name",
    name,
    "--resource-group",
    ctx.rg,
    "--output",
    "json",
  ])
}

function assertNoReplicas(ctx, name, inventory, allowedActiveRevision = null) {
  for (const revision of inventory) {
    if (!REVISION.test(revision?.name ?? "")) fail()
    if (revision.name === allowedActiveRevision && revision?.properties?.active === true) continue
    const replicas = jsonCommand("az", [
      "containerapp",
      "replica",
      "list",
      "--name",
      name,
      "--resource-group",
      ctx.rg,
      "--revision",
      revision.name,
      "--output",
      "json",
    ])
    if (!Array.isArray(replicas) || replicas.length !== 0) fail()
  }
}

function exactPair(ctx) {
  const pair = []
  for (const [name, url] of [
    [ctx.app, "https://app.lyrashieldai.com"],
    [ctx.scanner, "https://scanner.lyrashieldai.com"],
  ]) {
    const inventory = revisions(ctx, name)
    const revision = selectExactRevision(inventory, ctx.webImage)
    const wasActive = inventory.find((item) => item.name === revision).properties.active === true
    assertNoReplicas(ctx, name, inventory, wasActive ? revision : null)
    pair.push({ name, revision, url, wasActive })
  }
  return pair
}

function holdPair(ctx) {
  return [ctx.app, ctx.scanner].map((name) => {
    const inventory = revisions(ctx, name)
    return { name, revision: selectExactRevision(inventory, ctx.webImage, true) }
  })
}

function azMutation(ctx, args) {
  const result = spawnSync("az", [...args, "--output", "none"], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: "True" },
  })
  if (result.error?.code === "ETIMEDOUT" || [124, 137].includes(result.status)) {
    throw new Error("AMBIGUOUS_REMOTE_TIMEOUT")
  }
  if (result.error || result.status !== 0) fail()
}

function assertOnlyExactActive(ctx, pair) {
  for (const item of pair) {
    const active = revisions(ctx, item.name).filter(
      (revision) => revision?.properties?.active === true
    )
    if (
      active.length !== 1 ||
      active[0].name !== item.revision ||
      active[0]?.properties?.template?.containers?.[0]?.image !== ctx.webImage
    )
      fail()
    const traffic = jsonCommand("az", [
      "containerapp",
      "ingress",
      "traffic",
      "show",
      "--name",
      item.name,
      "--resource-group",
      ctx.rg,
      "--output",
      "json",
    ])
    if (
      !Array.isArray(traffic) ||
      traffic.filter((entry) => Number(entry.weight) > 0).length !== 1 ||
      !traffic.some((entry) => entry.revisionName === item.revision && Number(entry.weight) === 100)
    )
      fail()
  }
}

async function waitOnlyExactActive(ctx, pair) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      assertOnlyExactActive(ctx, pair)
      return
    } catch {
      if (attempt === 11) fail()
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

async function smoke(url, path) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(`${url}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      })
      await response.body?.cancel()
      if (response.status === 200) return
    } catch {
      /* fixed status only */
    }
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  fail()
}

async function readbackInactive(ctx, pair) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      for (const item of pair) {
        const inventory = revisions(ctx, item.name)
        if (
          !Array.isArray(inventory) ||
          inventory.some((revision) => revision?.properties?.active !== false)
        )
          fail()
        assertNoReplicas(ctx, item.name, inventory)
      }
      return true
    } catch {
      /* allow bounded Azure deactivation convergence */
    }
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  return false
}

async function deactivatePair(ctx, pair) {
  let deactivated = true
  for (const item of pair) {
    try {
      const selected = revisions(ctx, item.name).find(
        (revision) => revision?.name === item.revision
      )
      if (
        !selected ||
        selected?.properties?.template?.containers?.length !== 1 ||
        selected.properties.template.containers[0].image !== ctx.webImage
      )
        fail()
      if (selected.properties.active === true) {
        azMutation(ctx, [
          "containerapp",
          "revision",
          "deactivate",
          "--name",
          item.name,
          "--resource-group",
          ctx.rg,
          "--revision",
          item.revision,
        ])
      }
    } catch {
      deactivated = false
    }
  }
  if (!(await readbackInactive(ctx, pair))) deactivated = false
  if (!deactivated) throw new Error("WRITERS_NOT_CONFIRMED_INACTIVE")
}

async function apply(ctx, pair) {
  let mutated = false
  let archiveStarted = false
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
  }
  const assertNotInterrupted = () => {
    if (interrupted) throw new Error("INTERRUPTED")
  }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onInterrupt)
  try {
    for (const item of pair) {
      assertNotInterrupted()
      if (item.wasActive) continue
      mutated = true // a timed-out Azure mutation has an unknown outcome
      azMutation(ctx, [
        "containerapp",
        "revision",
        "activate",
        "--name",
        item.name,
        "--resource-group",
        ctx.rg,
        "--revision",
        item.revision,
      ])
      assertNotInterrupted()
    }
    for (const item of pair) {
      assertNotInterrupted()
      mutated = true
      azMutation(ctx, [
        "containerapp",
        "ingress",
        "traffic",
        "set",
        "--name",
        item.name,
        "--resource-group",
        ctx.rg,
        "--revision-weight",
        `${item.revision}=100`,
      ])
      assertNotInterrupted()
    }
    await waitOnlyExactActive(ctx, pair)
    assertNotInterrupted()
    await Promise.all(pair.map((item) => smoke(item.url, "/api/ready")))
    await smoke("https://app.lyrashieldai.com", "/api/ready/scans")
    assertNotInterrupted()
    verifyGithub(ctx)
    verifyProbe(ctx, vmPhase(ctx, "postrelease-probe"))
    assertNotInterrupted()
    archiveStarted = true
    const complete = vmPhase(ctx, "complete-postrelease")
    if (
      complete
        .split(/\r?\n/)
        .filter((line) => line === "WEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE").length !== 1
    )
      fail()
    verifyProbe(ctx, vmPhase(ctx, "postrelease-probe"))
    console.log(
      "Exact historical recovery finalization completed; app and scanner readiness passed."
    )
  } catch (error) {
    const ambiguous = error?.message === "AMBIGUOUS_REMOTE_TIMEOUT"
    if (mutated) {
      // A lost archive acknowledgement is not a reason to stop healthy writers.
      // Unknown receipt state cannot justify a blind revision mutation.
      const receiptState = provedReceiptState(ctx)
      if (receiptState === "completed") {
        if (!archiveStarted) throw new Error("COMPLETED_WITH_INCOMPLETE_ACTIVATION")
        console.log(
          "Completed finalization was proved after a lost acknowledgement; prepared writers remain active."
        )
        return
      }
      await deactivatePair(ctx, pair)
    }
    if (ambiguous) throw new Error("AMBIGUOUS_REMOTE_TIMEOUT")
    fail()
  } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onInterrupt)
  }
}

async function main() {
  const mode = process.argv[2]
  if (!["--plan", "--apply", "--hold"].includes(mode) || process.argv.length !== 3) fail()
  const ctx = context()
  verifyGithub(ctx, mode === "--hold")
  if (mode === "--hold") {
    const receiptState = provedReceiptState(ctx)
    if (receiptState === "completed") {
      console.log("Incident finalization is already complete; no writer closure was performed.")
      return
    }
    await deactivatePair(ctx, holdPair(ctx))
    console.log("Incident finalization closure confirmed: app and scanner writers inactive.")
    return
  }
  verifyProbe(ctx, vmPhase(ctx, "postrelease-probe"))
  const pair = exactPair(ctx)
  if (mode === "--plan") {
    console.log("Exact incident finalization plan passed; no revisions were activated.")
    return
  }
  await apply(ctx, pair)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error?.message === "WRITERS_NOT_CONFIRMED_INACTIVE"
        ? "Incident finalization failed; writers could not be confirmed inactive. Manual incident response is required."
        : error?.message === "RECEIPT_STATE_UNKNOWN"
          ? "Incident finalization state could not be proved; no writer closure was attempted. Manual incident response is required."
          : error?.message === "COMPLETED_WITH_INCOMPLETE_ACTIVATION"
            ? "Completed recovery was proved, but this app and scanner activation did not finish. Manual incident response is required."
            : error?.message === "AMBIGUOUS_REMOTE_TIMEOUT"
              ? "Incident finalization timed out with an ambiguous remote outcome. Inspect exact revisions and receipt before retrying."
              : "Incident finalization stopped; inspect held state before retrying."
    )
    process.exitCode = 1
  })
}
