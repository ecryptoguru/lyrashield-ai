/* eslint-disable security/detect-non-literal-fs-filename -- Only fixed source-controlled workflow URLs are read. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const runtime = readFileSync(
  new URL("../../workflows/deploy-azure-runtime.yml", import.meta.url),
  "utf8"
)
const release = readFileSync(
  new URL("../../workflows/release-retained-worker.yml", import.meta.url),
  "utf8"
)
const step = (name) => {
  const start = runtime.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, name)
  const end = runtime.indexOf("\n      - name:", start + 1)
  return runtime.slice(start, end < 0 ? runtime.length : end)
}

test("the usable retained release qualifies current main and builds only an immutable web image", () => {
  assert.match(release, /workflow_dispatch:/)
  assert.doesNotMatch(release, /confirmation:|workflow_call:/)
  assert.match(release, /if: github.ref == 'refs\/heads\/main'/)
  assert.match(release, /validate-webhook-deploy-dispatch.sh/)
  assert.match(release, /qualify-release-source.mjs/)
  assert.match(release, /environment: azure-production/)
  assert.match(release, /LYRASHIELD_RETAINED_WORKER_APPROVAL/)
  assert.match(release, /retained-legacy-runtime.mjs approve/)
  assert.equal((release.match(/uses: docker\/build-push-action@/g) ?? []).length, 1)
  assert.match(release, /target: runner\n          push: true\n          sbom: true/)
  assert.doesNotMatch(
    release,
    /:latest|target: worker|target: egress-proxy|repository: .*lyrashield-engine/
  )
  assert.match(release, /uses: \.\/\.github\/workflows\/deploy-azure-runtime.yml/)
  assert.match(release, /retained_worker: true/)
  assert.match(release, /worker_source_sha: \$\{\{ needs.approve.outputs.worker_source_sha \}\}/)
  assert.match(release, /"\$SOURCE" "\$ENGINE" "\$WORKER_SOURCE"/)
  assert.match(release, /cancel-in-progress: false/)
})
test("retained runtime checks precede all production mutations and cannot open a maintenance path", () => {
  const guard = runtime.indexOf(
    "      - name: Verify protected retained worker and relay before runtime mutations"
  )
  for (const name of [
    "Ensure app and scanner system identities",
    "Prepare private registry and zero-downtime rollout",
    "Run database migrations",
    "Deploy app Container App",
    "Promote healthy candidate revisions",
  ])
    assert.ok(guard < runtime.indexOf(`      - name: ${name}`), name)
  assert.match(
    step("Verify protected retained worker and relay before runtime mutations"),
    /if: inputs.retained_worker == true/
  )
  const controller = readFileSync(new URL("../v26-cutover.mjs", import.meta.url), "utf8")
  assert.match(controller, /if \(env.RETAINED_WORKER_SOURCE && !current\)/)
  assert.match(
    step("Verify worker queues are empty before traffic promotion"),
    /if \[ "\$RETAINED_WORKER" = true \]; then\n            node .github\/scripts\/retained-legacy-runtime.mjs readback/
  )
  assert.match(step("Smoke production traffic"), /retained-legacy-runtime.mjs readback/)
  assert.match(step("Smoke production traffic"), /APP_URL\/api\/ready\/scans/)
})
test("retained mode excludes every worker, worker-vault and relay deployment mutation", () => {
  for (const name of [
    "Sync BullMQ Redis secret to worker Key Vault",
    "Sync billing reconciliation credentials to worker Key Vault",
    "Sync isolated AI result-cache secrets to worker and app Key Vaults",
    "Sync isolated worker GitHub credentials",
    "Deploy egress-proxy Container App",
    "Refresh Azure OIDC login before ordinary worker promotion",
    "Promote verified worker digest on VM",
  ])
    assert.match(step(name), /if: (?:\$\{\{ )?inputs.retained_worker != true/)
  for (const name of [
    "Prepare private registry and zero-downtime rollout",
    "Smoke candidate revisions",
    "Promote healthy candidate revisions",
    "Smoke production traffic",
    "Deactivate superseded Container App revisions",
    "Roll back production traffic on health failure",
    "Deactivate zero-traffic candidates after failed rollout",
  ])
    assert.match(
      step(name),
      /EGRESS_(?:NAME|PROXY_CONTAINER_APP_NAME): \$\{\{ inputs.retained_worker != true && vars.AZURE_EGRESS_PROXY_CONTAINER_APP_NAME \|\| '' \}\}/
    )
})
test("retained mode preserves real source, schema, billing, image, migration and health rollback checks", () => {
  for (const path of [
    "assert-current-main.sh",
    "assert-no-prior-runtime-promotion.mjs",
    "assert-no-held-v26.sh",
    "verify-webhook-cutover.mjs",
    "verify-myra-deployment-config.mjs",
    "verify-billing-deployment-config.mjs",
    "v26-cutover.mjs prepare",
    "run-database-migrations",
    "smoke-candidate-revisions",
    "promote-healthy-candidate-revisions",
    "roll-back-production-traffic-on-health-failure",
    "deactivate-zero-traffic-candidates-after-failed-rollout",
  ])
    assert.ok(runtime.includes(path), path)
  const workerQueue = step("Verify worker queues are empty before traffic promotion")
  assert.ok(workerQueue.includes("verify-worker-queues-are-empty-before-traffic-promotion"))
  assert.match(runtime, /retained_worker: \{ required: false, default: false, type: boolean \}/)
})
