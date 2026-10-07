import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const deploy = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
const candidatePath = ".github/workflows/verify-webhook-worker-image.yml"
const candidate = existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : ""
const imageReferenceHelper = readFileSync(
  ".github/scripts/normalize-worker-image-reference.sh",
  "utf8"
)
const cutover = readFileSync(".github/scripts/verify-webhook-cutover.mjs", "utf8")
const preflight = readFileSync(".github/scripts/verify-webhook-cutover-preflight.mjs", "utf8")
const smoke = readFileSync(".github/scripts/webhook-track-image-smoke.mjs", "utf8")

function job(source, name) {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.notEqual(start, -1, `missing job ${name}`)
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line))
  return lines.slice(start, end < 0 ? lines.length : end).join("\n")
}

const baseline = job(deploy, "preflight-compatible-baseline")
const build = job(deploy, "build")
const preparedImages = job(deploy, "resolve-prepared-images")
const resolvedImages = job(deploy, "resolve-images")
const imageProof = job(deploy, "verify-built-worker-image")
const azureDeploy = job(deploy, "deploy")

assert.doesNotMatch(deploy + runtime, /WEBHOOK_LEGACY_TIMEZONE|verify-webhook-timezone-evidence/)
assert.match(deploy, /bash \.github\/scripts\/validate-webhook-deploy-dispatch\.sh/)
assert.match(baseline, /environment:\s*\n\s+name:\s*azure-production/)
assert.match(baseline, /id-token:\s*write/)
assert.match(baseline, /Confirm deployment source remains current main/)
assert.match(baseline, /verify-webhook-cutover-preflight\.mjs/)
assert.match(preflight, /verify-webhook-cutover\.mjs/)
assert.match(preflight, /webhook-claims-maintenance\.sh", "recovery-probe"/)
assert.match(preflight, /WEBHOOK_RECOVERY_RECEIPT_VERIFIED/)
assert.match(preflight, /WEBHOOK_RECOVERY_RECEIPT_ABSENT/)
assert.match(preflight, /webhook_claims_cutover=true/)
assert.match(preflight, /latestMainSha/)
assert.match(baseline, /RG:\s*\$\{\{\s*vars\.AZURE_RESOURCE_GROUP\s*\}\}/)
assert.match(
  baseline,
  /WORKER_VM_NAME:\s*\$\{\{\s*vars\.AZURE_WORKER_VM_NAME\s*\|\|\s*'lyrashield-worker'\s*\}\}/
)
assert.match(baseline, /AZURE_RESOURCE_GROUP:\s*\$\{\{\s*vars\.AZURE_RESOURCE_GROUP\s*\}\}/)
assert.match(
  baseline,
  /AZURE_APP_CONTAINER_APP_NAME:\s*\$\{\{\s*vars\.AZURE_APP_CONTAINER_APP_NAME\s*\}\}/
)
assert.match(
  baseline,
  /AZURE_SCANNER_CONTAINER_APP_NAME:\s*\$\{\{\s*vars\.AZURE_SCANNER_CONTAINER_APP_NAME\s*\}\}/
)
assert.match(
  baseline,
  /AZURE_KEY_VAULT_NAME:\s*\$\{\{\s*vars\.AZURE_KEY_VAULT_NAME\s*\|\|\s*'lyrashieldprodsecrets'\s*\}\}/
)
assert.match(baseline, /GHCR_USERNAME:\s*\$\{\{\s*github\.repository_owner\s*\}\}/)
assert.match(
  baseline,
  /LYRASHIELD_ADMISSION_STOP_OWNER:\s*\$\{\{\s*github\.run_id\s*\}\}:\$\{\{\s*github\.run_attempt\s*\}\}/
)
assert.match(baseline, /LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID:\s*\$\{\{\s*github\.run_id\s*\}\}/)
assert.match(runtime, /LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT:\s*\$\{\{\s*github\.run_attempt\s*\}\}/)
assert.match(baseline, /No container images were built or pushed/)
assert.ok(deploy.indexOf("preflight-compatible-baseline:") < deploy.indexOf("  build:"))
assert.match(
  build,
  /needs:[\s\S]*validate-manual-production-dispatch[\s\S]*preflight-compatible-baseline/
)
assert.match(build, /inputs\.held_recovery_original_run_id == ''/)
assert.match(preparedImages, /inputs\.held_recovery_original_run_id != ''/)
assert.match(preparedImages, /verify-webhook-recovery-candidate\.mjs/)
assert.match(resolvedImages, /needs:\s*\[build, resolve-prepared-images\]/)
assert.match(
  resolvedImages,
  /\[ "\$BUILD_RESULT" = success \] && \[ "\$PREPARED_RESULT" = skipped \]/
)
assert.match(
  resolvedImages,
  /\[ "\$PREPARED_RESULT" = success \] && \[ "\$BUILD_RESULT" = skipped \]/
)
assert.match(imageProof, /needs:\s*resolve-images/)
assert.match(
  imageProof,
  /if: \$\{\{ !cancelled\(\) && needs\.resolve-images\.result == 'success' \}\}/
)
assert.match(imageProof, /verify-webhook-worker-image\.yml/)
assert.match(
  imageProof,
  /needs\.resolve-images\.outputs\.worker_image \}\}@\$\{\{ needs\.resolve-images\.outputs\.worker_digest/
)
assert.match(azureDeploy, /needs:[\s\S]*verify-built-worker-image/)
assert.match(azureDeploy, /needs:[\s\S]*resolve-images/)
assert.match(
  azureDeploy,
  /worker_digest: \$\{\{ needs\.resolve-images\.outputs\.worker_digest \}\}/
)
assert.match(runtime, /Verify compatible webhook cutover baseline[\s\S]*Run database migrations/)
assert.match(cutover, /webhook-production-cutover\.md/)
assert.match(cutover, /durable-claims\/1/)
assert.match(
  deploy,
  /webhook_claims_cutover: \$\{\{ needs\.preflight-compatible-baseline\.outputs\.webhook_claims_cutover == 'true' \}\}/
)

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

const recoveryGate = runtime.indexOf(
  "- name: Revalidate retry state for an automatic first cutover"
)
assert.ok(recoveryGate > -1)
assert.match(runtime, /bash \.github\/scripts\/webhook-claims-maintenance\.sh recovery-probe/)
assert.match(runtime, /steps\.cutover-retry\.outputs\.receipt == 'absent'/)
assert.match(
  runtime,
  /\(failure\(\) \|\| cancelled\(\)\).*steps\.webhook-stop\.outcome != 'skipped'/
)
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

assert.match(baseline, /if: github.ref == 'refs\/heads\/main'/)
assert.ok(
  baseline.indexOf("Validate required Azure writer configuration") <
    baseline.indexOf("Log in to Azure")
)
assert.match(baseline, /test -n "\$AZURE_RESOURCE_GROUP"/)
assert.match(baseline, /test -n "\$AZURE_APP_CONTAINER_APP_NAME"/)
assert.match(job(deploy, "build"), /needs\.preflight-compatible-baseline\.result == 'success'/)
assert.doesNotMatch(job(deploy, "build"), /preflight-compatible-baseline\.result == 'skipped'/)

const configurationStep = baseline.slice(
  baseline.indexOf("- name: Validate required Azure writer configuration"),
  baseline.indexOf("- name: Log in to Azure")
)
const configurationShell = configurationStep.split("run: |\n")[1].trim()
for (const [group, app, expectedStatus] of [
  ["", "app", 1],
  ["group", "", 1],
  ["group", "app", 0],
]) {
  const checked = spawnSync("bash", ["-c", configurationShell], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AZURE_RESOURCE_GROUP: group, AZURE_APP_CONTAINER_APP_NAME: app },
  })
  assert.equal(checked.status, expectedStatus)
}

for (const guardedWorkflow of [baseline, runtime]) {
  assert.match(
    guardedWorkflow,
    /AZURE_WEBHOOK_WRITER_TOPOLOGY: \$\{\{ vars\.AZURE_WEBHOOK_WRITER_TOPOLOGY \|\| 'app-and-scanner' \}\}/
  )
}
assert.equal((runtime.match(/AZURE_WEBHOOK_WRITER_TOPOLOGY:/g) ?? []).length, 2)

console.log("Webhook production preflight invariants passed.")
