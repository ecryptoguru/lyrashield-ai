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

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  }).trim()
}

function main() {
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
