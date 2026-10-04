import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

const deploy = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
const verifier = readFileSync(".github/workflows/verify-webhook-production-prerequisites.yml", "utf8")
const candidatePath = ".github/workflows/verify-webhook-worker-image.yml"
const candidate = existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : ""
const imageReferenceHelper = readFileSync(".github/scripts/normalize-worker-image-reference.sh", "utf8")
const cutover = readFileSync(".github/scripts/verify-webhook-cutover.mjs", "utf8")
const smoke = readFileSync(".github/scripts/webhook-track-image-smoke.mjs", "utf8")

function job(source, name) {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.notEqual(start, -1, `missing job ${name}`)
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line))
  return lines.slice(start, end < 0 ? lines.length : end).join("\n")
}

const evidence = job(deploy, "preflight-cutover-evidence")
const baseline = job(deploy, "preflight-compatible-baseline")
const build = job(deploy, "build")
const imageProof = job(deploy, "verify-built-worker-image")
const azureDeploy = job(deploy, "deploy")

assert.match(evidence, /environment:\s*\n\s+name:\s*azure-production/)
assert.match(evidence, /secrets\.DATABASE_DIRECT_URL/)
assert.match(evidence, /secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT/)
assert.match(evidence, /secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM/)
assert.match(evidence, /needs:\s*validate-manual-production-dispatch/)
assert.doesNotMatch(evidence, /id-token:\s*write|azure\/login|az login/)
assert.match(deploy, /recovery_requires_receipt:\s*\$\{\{\s*steps\.dispatch\.outputs\.recovery_requires_receipt\s*\}\}/)
assert.match(deploy, /bash \.github\/scripts\/validate-webhook-deploy-dispatch\.sh/)
assert.match(evidence, /RECOVERY_REQUIRES_RECEIPT:\s*\$\{\{\s*needs\.validate-manual-production-dispatch\.outputs\.recovery_requires_receipt\s*\}\}/)
assert.match(evidence, /SOURCE_SHA.*RECOVERY_REQUIRES_RECEIPT.*current main/s)
assert.match(baseline, /environment:\s*\n\s+name:\s*azure-production/)
assert.match(baseline, /id-token:\s*write/)
assert.match(baseline, /verify-webhook-cutover\.mjs/)
assert.match(baseline, /Confirm deployment source remains current main/)
assert.match(baseline, /No container images were built or pushed/)
assert.ok(deploy.indexOf("preflight-compatible-baseline:") < deploy.indexOf("  build:"))
assert.ok(deploy.indexOf("preflight-cutover-evidence:") < deploy.indexOf("  build:"))
assert.match(build, /needs:[\s\S]*preflight-cutover-evidence[\s\S]*preflight-compatible-baseline/)
assert.match(imageProof, /needs:\s*build/)
assert.match(imageProof, /verify-webhook-worker-image\.yml/)
assert.match(imageProof, /worker_digest/)
assert.match(azureDeploy, /needs:[\s\S]*verify-built-worker-image/)
assert.match(runtime, /Verify compatible webhook cutover baseline[\s\S]*Run database migrations/)
assert.match(cutover, /webhook-production-cutover\.md/)
assert.match(cutover, /webhook-cutover:/)

assert.match(verifier, /workflow_dispatch:/)
assert.doesNotMatch(verifier, /workflow_run:/)
assert.match(verifier, /validate-request:/)
assert.match(verifier, /worker_source_sha:/)
assert.match(verifier, /needs: validate-request[\s\S]*?verify-worker-image:/)
assert.doesNotMatch(verifier, /needs: verify-timezone-receipt/)
assert.match(verifier, /worker_image:/)
assert.match(verifier, /verify-webhook-worker-image\.yml/)
assert.doesNotMatch(verifier, /sha256:caf33ad|86537799e615fb3c07376106b315393e81d7ae9d/)
assert.match(candidate, /workflow_call:/)
assert.match(imageReferenceHelper, /sha256:\[a-f0-9\]\{64\}/)
assert.match(candidate, /postgres:16-alpine/)
assert.match(candidate, /redis:7-alpine/)
assert.match(candidate, /EXPECTED_SOURCE_SHA:\s*\$\{\{ inputs\.product_source_sha \}\}/)
assert.match(candidate, /EXPECTED_ENGINE_REVISION:\s*\$\{\{ inputs\.engine_revision \}\}/)
assert.match(candidate, /WORKER_IMAGE:\s*\$\{\{ inputs\.worker_image \}\}/)
assert.match(candidate, /normalize-worker-image-reference\.sh/)
assert.match(candidate, /docker image inspect "\$CANONICAL_WORKER_IMAGE"/)
assert.match(candidate, /grep -Fxq "\$CANONICAL_WORKER_IMAGE"/)
assert.match(candidate, /--read-only/)
assert.doesNotMatch(candidate, /environment:|secrets\.|id-token:|azure\/login/)

const recoveryGate = runtime.indexOf("- name: Verify existing owned receipt before original-source recovery")
assert.ok(recoveryGate > -1)
assert.match(runtime, /bash \.github\/scripts\/webhook-claims-maintenance\.sh recovery/)
for (const mutation of [
  "Ensure app and scanner system identities",
  "Prepare private registry and zero-downtime rollout",
  "Run database migrations",
  "Promote healthy candidate revisions",
]) {
  assert.ok(recoveryGate < runtime.indexOf("- name: " + mutation), mutation)
}

assert.match(smoke, /recoverDueWebhookTrackRetries/)
assert.match(smoke, /claim_expired_requires_receipt_review/)
assert.match(smoke, /fixture-worker-smoke-pro-monthly/)
assert.doesNotMatch(smoke, /process\.env\.(?:POLAR|RAZORPAY)|fetch\(|https?:\/\//)

await import("../../../packages/db/scripts/tests/webhook-empty-state-migration.contract.mjs")

console.log("Webhook production preflight invariants passed.")
