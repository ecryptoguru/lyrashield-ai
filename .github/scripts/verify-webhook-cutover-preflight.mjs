import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export function selectPreflightAction({ runAttempt, sourceSha, latestMainSha, retryReceiptState }) {
  if (runAttempt > 1) {
    if (retryReceiptState === "verified") return "reuse-first-cutover"
    if (retryReceiptState !== "absent") {
      throw new Error("Cutover retry receipt state is ambiguous; refusing release")
    }
  }

  if (sourceSha !== latestMainSha) {
    throw new Error(
      "Release source is no longer current main and no owned cutover receipt authorizes this retry"
    )
  }
  return "classify-baseline"
}

export function receiptStateFromProbe(probe) {
  const lines = probe.split(/\r?\n/)
  const verifiedCount = lines.filter((line) => line === "WEBHOOK_RECOVERY_RECEIPT_VERIFIED").length
  const absentCount = lines.filter((line) => line === "WEBHOOK_RECOVERY_RECEIPT_ABSENT").length
  if (verifiedCount === 1 && absentCount === 0) return "verified"
  if (absentCount === 1 && verifiedCount === 0) return "absent"
  throw new Error("Cutover retry receipt state is ambiguous; refusing release")
}

export function recoveryIdentityFromProbe(probe, expected) {
  const lines = probe.split(/\r?\n/)
  const marker = "WEBHOOK_NEW_RUN_RECOVERY_VERIFIED"
  const forbidden = [
    "WEBHOOK_RECOVERY_RECEIPT_ABSENT",
    "WEBHOOK_RECOVERY_RECEIPT_VERIFIED",
    "WEBHOOK_SAME_RUN_CUTOVER_VERIFIED",
  ]
  if (
    lines.filter((line) => line === marker).length !== 1 ||
    forbidden.some((value) => lines.includes(value))
  ) {
    throw new Error("New-run recovery receipt is absent or ambiguous")
  }
  const read = (name, pattern) => {
    const values = lines.filter((line) => line.startsWith(`${name}=`))
    if (values.length !== 1) throw new Error("New-run recovery identity is incomplete or ambiguous")
    const value = values[0].slice(name.length + 1)
    if (!pattern.test(value)) throw new Error("New-run recovery identity is malformed")
    return value
  }
  const owner = read("WEBHOOK_RECOVERY_OWNER", /^[1-9][0-9]*:[1-9][0-9]*$/)
  const runId = read("WEBHOOK_RECOVERY_OWNER_RUN_ID", /^[1-9][0-9]*$/)
  const sourceSha = read("WEBHOOK_RECOVERY_OWNER_SOURCE_SHA", /^[a-f0-9]{40}$/)
  if (
    runId !== expected.runId ||
    owner !== expected.owner ||
    sourceSha !== expected.sourceSha ||
    !owner.startsWith(`${runId}:`)
  ) {
    throw new Error("New-run recovery receipt does not match the requested original identity")
  }
  return { owner, runId, sourceSha }
}

export function assertOriginalCutoverRun(run, expected, jobs) {
  const deployAzurePaths = new Set([
    ".github/workflows/deploy-azure.yml",
    ".github/workflows/deploy-azure.yml@main",
    ".github/workflows/deploy-azure.yml@refs/heads/main",
  ])
  const directDeploy = deployAzurePaths.has(run?.path)
  const releaseProduction =
    run?.path === ".github/workflows/release-production.yml" && run?.event === "push"
  const failedWorkerJobs = Array.isArray(jobs)
    ? jobs.filter((job) => {
        if (
          ![
            "Deploy Azure Container Apps",
            "deploy-azure / Deploy Azure Container Apps",
            "deploy-azure / Deploy Azure Container Apps / Deploy Azure Container Apps",
          ].includes(job?.name) ||
          job?.conclusion !== "failure" ||
          !Array.isArray(job.steps)
        ) {
          return false
        }
        const failedBootSteps = job.steps.filter(
          (step) =>
            step?.name === "Boot compatible worker before opening webhook ingress" &&
            step?.conclusion === "failure"
        )
        return failedBootSteps.length === 1
      })
    : []
  const preflightJobs = Array.isArray(jobs)
    ? jobs.filter(
        (job) =>
          job?.name === "deploy-azure / Check existing webhook writers before image build" &&
          job?.conclusion === "success"
      )
    : []
  if (
    run?.id !== Number(expected.runId) ||
    run.head_sha !== expected.sourceSha ||
    run.head_branch !== "main" ||
    (!directDeploy && !releaseProduction) ||
    run.status !== "completed" ||
    !["failure", "cancelled"].includes(run.conclusion) ||
    (releaseProduction &&
      (run.conclusion !== "failure" || failedWorkerJobs.length !== 1 || preflightJobs.length !== 1))
  ) {
    throw new Error("Original cutover GitHub run metadata does not match the held receipt")
  }
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  }).trim()
}

function main() {
  const newRunRecovery = process.argv[2] === "--new-run-recovery"
  if (process.argv.length !== (newRunRecovery ? 3 : 2)) {
    throw new Error("Unknown webhook cutover preflight argument")
  }
  const sourceSha = process.env.DEPLOY_SHA
  const repository = process.env.GITHUB_REPOSITORY
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  const outputPath = process.env.GITHUB_OUTPUT
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) {
    throw new Error("Full deployment source SHA is required")
  }
  if (!repository || !Number.isSafeInteger(attempt) || attempt < 1 || !outputPath) {
    throw new Error("GitHub release context is incomplete")
  }

  const checkoutSha = run("git", ["rev-parse", "HEAD"])
  if (checkoutSha !== sourceSha)
    throw new Error("Preflight checkout does not match deployment source")

  if (newRunRecovery) {
    const expected = {
      runId: process.env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID,
      owner: process.env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER,
      sourceSha: process.env.LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA,
    }
    if (
      !/^[1-9][0-9]*$/.test(expected.runId ?? "") ||
      !/^[1-9][0-9]*:[1-9][0-9]*$/.test(expected.owner ?? "") ||
      !/^[a-f0-9]{40}$/.test(expected.sourceSha ?? "") ||
      !expected.owner.startsWith(`${expected.runId}:`) ||
      process.env.GITHUB_RUN_ID === expected.runId
    ) {
      throw new Error("Explicit original run, owner and source are required for new-run recovery")
    }
    const latestMainSha = run("gh", [
      "api",
      `repos/${repository}/git/ref/heads/main`,
      "--jq",
      ".object.sha",
    ])
    if (sourceSha !== latestMainSha) {
      throw new Error("Recovery candidate must be the exact current main commit")
    }
    const originalRun = JSON.parse(
      run("gh", ["api", `repos/${repository}/actions/runs/${expected.runId}`])
    )
    let originalJobs
    if (originalRun.path === ".github/workflows/release-production.yml") {
      const originalJobResponse = JSON.parse(
        run("gh", ["api", `repos/${repository}/actions/runs/${expected.runId}/jobs?per_page=100`])
      )
      if (
        !Array.isArray(originalJobResponse.jobs) ||
        originalJobResponse.total_count !== originalJobResponse.jobs.length
      ) {
        throw new Error("Original cutover GitHub run jobs are incomplete or ambiguous")
      }
      originalJobs = originalJobResponse.jobs
    }
    assertOriginalCutoverRun(originalRun, expected, originalJobs)
    const probe = run("bash", [
      ".github/scripts/webhook-claims-maintenance.sh",
      "recovery-probe-new-run",
    ])
    const identity = recoveryIdentityFromProbe(probe, expected)
    appendFileSync(outputPath, `held_recovery_original_run_id=${identity.runId}\n`)
    appendFileSync(outputPath, `held_recovery_original_owner=${identity.owner}\n`)
    appendFileSync(outputPath, `held_recovery_original_source_sha=${identity.sourceSha}\n`)
    appendFileSync(outputPath, "held_recovery_verified=true\n")
    console.log("Verified an explicitly bound held cutover for a separate recovery run.")
    return
  }

  let retryReceiptState = "not-applicable"
  if (attempt > 1) {
    const probe = run("bash", [".github/scripts/webhook-claims-maintenance.sh", "recovery-probe"])
    retryReceiptState = receiptStateFromProbe(probe)
  }

  const latestMainSha = run("gh", [
    "api",
    `repos/${repository}/git/ref/heads/main`,
    "--jq",
    ".object.sha",
  ])
  const action = selectPreflightAction({
    runAttempt: attempt,
    sourceSha,
    latestMainSha,
    retryReceiptState,
  })

  if (action === "reuse-first-cutover") {
    appendFileSync(outputPath, "webhook_claims_cutover=true\n")
    appendFileSync(outputPath, "webhook_cutover_retry_receipt=verified\n")
    console.log("Verified same-run cutover receipt; preserving first-cutover mode for retry.")
    return
  }

  run("node", [".github/scripts/verify-webhook-cutover.mjs", "--github-output", outputPath])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
