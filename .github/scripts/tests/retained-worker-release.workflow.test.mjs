/* eslint-disable security/detect-non-literal-fs-filename -- Only fixed source-controlled workflow URLs are read. */
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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

test("the held retained release preserves source and immutable-image checks behind qualification", () => {
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
  assert.match(release, /\n  build:\n[\s\S]*?\n    needs: approve\n/)
  assert.match(release, /\n  deploy:\n[\s\S]*?\n    needs: \[approve, build\]\n/)
  assert.doesNotMatch(release, /continue-on-error:|if:.*always\(/)
  assert.ok(
    release.indexOf("Hold production until runtime qualification") <
      release.indexOf("Checkout trusted main validator")
  )
  assert.match(
    release,
    /current worker protections, sandbox and isolated runtime authority remain unqualified/
  )
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
    /if \[ "\$RETAINED_WORKER" = true \]; then\n            node .github\/scripts\/v26-cutover.mjs retained-schema\n            node .github\/scripts\/retained-legacy-runtime.mjs readback/
  )
  assert.match(step("Smoke production traffic"), /retained-legacy-runtime.mjs readback-identity\b/)
  assert.match(step("Smoke production traffic"), /APP_URL\/api\/ready\/scans/)
  const migration = step("Run database migrations")
  assert.ok(migration.indexOf("run-database-migrations") < migration.indexOf("retained-schema"))
  assert.match(
    migration,
    /if \[ "\$RETAINED_WORKER" = true \]; then node .github\/scripts\/v26-cutover.mjs retained-schema; fi/
  )
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

test("post-promotion smoke accepts only HTTP 200 and calls identity readback", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "retained-smoke-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "bash"), "#!/bin/sh\nexit 0\n")
  writeFileSync(
    join(dir, "node"),
    '#!/bin/sh\n[ -z "${EXPECT_MODE:-}" ] || [ "$2" = "$EXPECT_MODE" ]\n'
  )
  writeFileSync(
    join(dir, "curl"),
    '#!/bin/sh\nprintf "%s" "${HTTP_STATUS:-200}"\n[ -z "${CURL_FAIL:-}" ]\n'
  )
  for (const command of ["bash", "node", "curl"]) chmodSync(join(dir, command), 0o700)
  const smoke = step("Smoke production traffic").split("        run: |\n")[1]
  const run = (extra = {}) =>
    spawnSync("/bin/bash", ["-e", "-c", smoke], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir + ":" + process.env.PATH,
        APP_URL: "https://app.example.test",
        RETAINED_WORKER: "true",
        ...extra,
      },
    })
  assert.equal(run().status, 0)
  for (const status of ["301", "302", "503", "000"])
    assert.notEqual(run({ HTTP_STATUS: status }).status, 0, status)
  assert.notEqual(run({ CURL_FAIL: "1" }).status, 0)
  assert.equal(run({ EXPECT_MODE: "readback-identity" }).status, 0)
})
