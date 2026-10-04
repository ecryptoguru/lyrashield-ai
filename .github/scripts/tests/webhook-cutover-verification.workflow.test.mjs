import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const workflowPath = ".github/workflows/verify-webhook-production-prerequisites.yml"
const workflow = readFileSync(workflowPath, "utf8")
const ci = readFileSync(".github/workflows/ci.yml", "utf8")
const smoke = readFileSync(".github/scripts/webhook-track-image-smoke.mjs", "utf8")

assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\[main\]/)
assert.match(workflow, /workflow_run:\s*\n\s+workflows:\s*\[CI\]/)
assert.doesNotMatch(workflow, /workflow_dispatch:|id-token:\s*write|deploy-azure-runtime\.yml|webhook_claims_cutover/)
assert.ok(workflow.includes("group: webhook-production-prerequisites-${{ github.event_name }}-${{ github.event.pull_request.head.sha || github.event.workflow_run.head_sha || github.sha }}"))
assert.ok(workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"))
assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/)
assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/)
assert.match(workflow, /github\.event\.workflow_run\.head_sha == github\.sha/)
assert.match(workflow, /branches:\s*\[main\]/)
assert.match(workflow, /codex\/no-deployment-cutover-verification-20261004/)

const receiptJob = workflow.match(/  verify-timezone-receipt:[\s\S]*?(?=\n  verify-worker-image:)/)?.[0]
assert.ok(receiptJob, "protected receipt job must be present")
assert.match(receiptJob, /environment:\s*\n\s+name:\s*azure-production/)
assert.match(receiptJob, /permissions:\s*\n\s+contents:\s*read/)
assert.doesNotMatch(receiptJob, /id-token:|AZURE_|azure\/login|deploy-azure-runtime|webhook_claims_cutover/)
assert.match(receiptJob, /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
assert.match(receiptJob, /github\.event_name == 'workflow_run'/)
assert.doesNotMatch(receiptJob, /github\.event\.pull_request|head\.repo/)
assert.match(receiptJob, /persist-credentials:\s*false/)
assert.match(receiptJob, /secrets\.DATABASE_DIRECT_URL/)
assert.match(receiptJob, /secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT/)
assert.match(receiptJob, /secrets\.WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM/)
assert.match(receiptJob, /node \.github\/scripts\/verify-webhook-timezone-evidence\.mjs/)

const imageJob = workflow.match(/  verify-worker-image:[\s\S]*$/)?.[0]
assert.ok(imageJob, "worker image job must be present")
assert.doesNotMatch(imageJob, /environment:|secrets\.|id-token:|azure\/login/)
assert.match(imageJob, /DATABASE_DIRECT_URL: postgresql:\/\/lyrashield:lyrashield@localhost:5432\/lyrashield/)
assert.match(workflow, /ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-worker@sha256:caf33ad26c34852456579afd9bf1865825cb059e3c8941fdf9acbab74aa0587a/)
assert.match(workflow, /86537799e615fb3c07376106b315393e81d7ae9d/)
assert.match(workflow, /3001517530300ca5f602536bfadcbd3c95ad3039/)
assert.match(imageJob, /postgres:16-alpine/)
assert.match(imageJob, /redis:7-alpine/)
assert.match(imageJob, /version: 12\.2\.0/)
assert.match(imageJob, /docker run --rm/)
assert.match(imageJob, /--read-only/)
assert.match(imageJob, /LYRASHIELD_TEST_DB_DISPOSABLE=1/)
assert.ok(
  imageJob.includes("--env 'POLAR_PRODUCT_IDS={\"pro_monthly\":\"fixture-worker-smoke-pro-monthly\"}'"),
  "worker image must receive only the synthetic Polar catalog fixture"
)
assert.ok(imageJob.includes("--env POLAR_LOCAL_PRODUCT_IDS="))
assert.match(imageJob, /docker network disconnect "\$network" "\$POSTGRES_CONTAINER"/)

assert.match(ci, /webhook-cutover-verification\.workflow\.test\.mjs/)
assert.match(smoke, /dispatchAffiliate/)
assert.match(smoke, /recoverDueWebhookTrackRetries/)
assert.match(smoke, /claim_expired_requires_receipt_review/)
assert.match(smoke, /WebhookEventTrack/)
assert.match(smoke, /skipped_succeeded/)
assert.match(smoke, /finally/)
assert.match(smoke, /Refusing non-local or non-disposable integration endpoints/)
assert.match(smoke, /fixture-worker-smoke-pro-monthly/)
assert.match(smoke, /dispatchAttempts, 3/)
assert.doesNotMatch(smoke, /process\.env\.(?:POLAR|RAZORPAY)|fetch\(|https?:\/\//)

console.log("Webhook cutover verification workflow invariants passed.")

await import("../../../packages/db/scripts/tests/webhook-empty-state-migration.contract.mjs")
