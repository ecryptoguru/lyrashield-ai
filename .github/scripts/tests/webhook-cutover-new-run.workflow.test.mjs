import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const dispatch = readFileSync(".github/workflows/recover-held-webhook-cutover.yml", "utf8")
const deploy = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
const image = readFileSync(".github/workflows/verify-webhook-worker-image.yml", "utf8")

function step(source, name) {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `missing step: ${name}`)
  const next = source.indexOf("      - name: ", start + marker.length)
  return source.slice(start, next < 0 ? undefined : next)
}

test("dedicated dispatch binds original identity and shares ordinary deployment lock", () => {
  for (const input of [
    "source_sha",
    "prepared_run_id",
    "original_run_id",
    "original_owner",
    "original_source_sha",
  ]) {
    assert.match(
      dispatch,
      new RegExp(`^      ${input}:\\n(?:.*\\n){1,4}        required: true$`, "m")
    )
  }
  assert.match(dispatch, /DISPATCH_REF: \$\{\{ github\.ref \}\}/)
  assert.match(dispatch, /if \[\[ "\$DISPATCH_REF" != 'refs\/heads\/main' \]\]/)
  assert.match(dispatch, /uses: \.\/\.github\/workflows\/deploy-azure\.yml/)
  assert.match(deploy, /group: deploy-azure-/)
  assert.match(dispatch, /held_recovery_original_run_id: \$\{\{ inputs\.original_run_id \}\}/)
  assert.match(dispatch, /held_recovery_prepared_run_id: \$\{\{ inputs\.prepared_run_id \}\}/)
  assert.match(dispatch, /held_recovery_original_owner: \$\{\{ inputs\.original_owner \}\}/)
  assert.match(
    dispatch,
    /held_recovery_original_source_sha: \$\{\{ inputs\.original_source_sha \}\}/
  )
})

test("recovery preflight runs before image build and passes only verified receipt outputs", () => {
  assert.match(
    step(deploy, "Classify webhook baseline before image build"),
    /if: inputs\.held_recovery_original_run_id == ''/
  )
  const preflight = step(deploy, "Verify explicitly scoped held cutover before image build")
  assert.match(preflight, /verify-webhook-cutover-preflight\.mjs --new-run-recovery/)
  assert.match(preflight, /LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER/)
  assert.match(preflight, /LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA/)
  assert.ok(deploy.indexOf("Verify explicitly scoped held cutover") < deploy.indexOf("  build:"))
  assert.match(
    deploy,
    /held_recovery: \$\{\{ needs\.preflight-compatible-baseline\.outputs\.held_recovery_verified == 'true' \}\}/
  )
  assert.match(deploy, /verify-built-worker-image,[\s\S]*preflight-compatible-baseline/)
})

test("held recovery selects only successful prepared digests and skips rebuild and cleanup", () => {
  const build = deploy.slice(
    deploy.indexOf("  build:\n"),
    deploy.indexOf("  resolve-prepared-images:\n")
  )
  const prepared = deploy.slice(
    deploy.indexOf("  resolve-prepared-images:\n"),
    deploy.indexOf("  resolve-images:\n")
  )
  const selected = deploy.slice(
    deploy.indexOf("  resolve-images:\n"),
    deploy.indexOf("  # Every merge to main")
  )
  assert.match(build, /inputs\.held_recovery_original_run_id == ''/)
  assert.match(prepared, /verify-webhook-recovery-candidate\.mjs/)
  assert.match(prepared, /held_recovery_prepared_run_id/)
  assert.match(prepared, /needs\.preflight-compatible-baseline\.result == 'success'/)
  assert.match(selected, /\[ "\$PREPARED_RESULT" = success \] && \[ "\$BUILD_RESULT" = skipped \]/)
  assert.match(
    deploy,
    /worker_image: \$\{\{ needs\.resolve-images\.outputs\.worker_image \}\}@\$\{\{ needs\.resolve-images\.outputs\.worker_digest \}\}/
  )
  assert.match(
    deploy,
    /if: inputs\.held_recovery_original_run_id == '' && needs\.build\.result == 'success'/
  )
})

test("held recovery keeps migration, claim, secret rotation and old-writer rollback out of its path", () => {
  for (const name of [
    "Verify compatible webhook cutover baseline",
    "Verify migration database continuity before maintenance",
    "Claim webhook maintenance admission stop",
    "Quiesce every old webhook writer",
    "Read back excluded writers immediately before migration",
    "Run database migrations",
    "Prepare private registry and zero-downtime rollout",
    "Sync BullMQ Redis secret to worker Key Vault",
    "Sync billing reconciliation credentials to worker Key Vault",
    "Sync evidence envelope key to app Container App",
    "Sync evidence storage credentials to app Container App",
    "Sync IP hash salt Key Vault reference",
    "Sync Myra secrets to app Container App",
    "Sync Upstash secrets to Container Apps",
    "Sync isolated AI result-cache secrets to worker and app Key Vaults",
    "Sync BullMQ Redis secret to Container Apps",
    "Sync billing provider secrets to app Container App",
    "Sync GitHub App secrets to app Container App",
    "Promote verified worker digest on VM",
    "Roll back production traffic on health failure",
    "Restore prior ingress mode after failed rollout",
    "Deactivate zero-traffic candidates after failed rollout",
  ]) {
    assert.match(step(runtime, name), /inputs\.held_recovery != true/, name)
  }
  assert.match(
    step(runtime, "Revalidate original held cutover before recovery mutations"),
    /--new-run-recovery/
  )
  assert.match(
    step(runtime, "Keep original admission held and old writers inactive"),
    /recovery-hold/
  )
})

test("failed held-recovery cleanup binds the prepared web image and honors completed proof", () => {
  const cleanup = step(runtime, "Disable webhook writers after failed held recovery")
  assert.match(
    cleanup,
    /WEB_IMAGE_REFERENCE: \$\{\{ inputs\.web_image \}\}@\$\{\{ inputs\.web_digest \}\}/
  )
  const completedCheck = cleanup.indexOf("grep -Fqx WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED")
  const noStopCheck = cleanup.indexOf("grep -Fqx WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP")
  assert.ok(completedCheck >= 0, "cleanup must recognize a verified completed recovery")
  assert.ok(
    noStopCheck > completedCheck,
    "completed proof must be handled before the no-stop summary"
  )
  assert.match(
    cleanup,
    /The recovery completion and public readiness were already proved\. Prepared writers remain active/
  )
})

test("exact image startup and migrated schema proof gate held worker boot before release", () => {
  assert.match(
    image,
    /WEBHOOK_RECOVERY_SCHEMA_POSTGRES_URL: postgresql:\/\/lyrashield:lyrashield@127\.0\.0\.1:5432\/lyrashield/
  )
  assert.match(
    image,
    /node --test \.github\/scripts\/tests\/webhook-cutover-schema\.postgres\.test\.mjs/
  )
  assert.match(
    image,
    /node --test \.github\/scripts\/tests\/webhook-cutover-release\.redis\.test\.mjs/
  )
  const boot = step(
    image,
    "Boot the exact worker image to readiness with production startup checks"
  )
  assert.match(boot, /docker run --detach \\/)
  assert.doesNotMatch(boot, /docker run --detach \+/)
  assert.match(boot, /--env NODE_ENV=production/)
  assert.match(boot, /test -f \/tmp\/lyrashield-worker-ready/)
  const order = [
    "Revalidate original held cutover before recovery mutations",
    "Keep original admission held and old writers inactive",
    "Deploy app Container App",
    "Deploy scanner Container App",
    "Boot compatible worker before opening webhook ingress",
    "Promote healthy candidate revisions",
    "Smoke production traffic",
    "Verify installed compatible webhook writer baseline",
    "Release only original admission after verified held recovery",
    "Verify scan readiness after held recovery release",
    "Archive completed held recovery evidence",
  ]
  let last = -1
  for (const name of order) {
    const next = runtime.indexOf(`      - name: ${name}\n`)
    assert.ok(next > last, name)
    last = next
  }
  assert.match(
    step(runtime, "Release only original admission after verified held recovery"),
    /resume-recovery/
  )
  assert.match(step(runtime, "Archive completed held recovery evidence"), /complete-recovery/)
  assert.match(step(runtime, "Disable webhook writers after failed held recovery"), /recovery-hold/)
})

test("prepared-image recovery reaches rehearsal and deploy despite the skipped build ancestor", () => {
  const rehearsal = deploy.slice(
    deploy.indexOf("  verify-built-worker-image:\n"),
    deploy.indexOf("  deploy:\n")
  )
  assert.match(rehearsal, /if:.*!cancelled\(\).*needs\.resolve-images\.result == 'success'/)
  const rollout = deploy.slice(
    deploy.indexOf("  deploy:\n"),
    deploy.indexOf("  verify-held-recovery-outcome:\n")
  )
  assert.match(rollout, /if: >\n\s*!cancelled\(\)/)
  for (const prerequisite of [
    "resolve-images",
    "verify-built-worker-image",
    "validate-manual-production-dispatch",
    "preflight-compatible-baseline",
  ]) {
    assert.ok(
      rollout.includes(`needs.${prerequisite}.result == 'success'`),
      `missing success gate: ${prerequisite}`
    )
  }
})

test("held recovery cannot report success with runtime deployment skipped", () => {
  const outcome = deploy.slice(deploy.indexOf("  verify-held-recovery-outcome:\n"))
  assert.match(outcome, /needs: deploy/)
  assert.match(outcome, /if:.*!cancelled\(\).*inputs\.held_recovery_original_run_id != ''/)
  assert.match(outcome, /DEPLOY_RESULT: \$\{\{ needs\.deploy\.result \}\}/)
  assert.match(outcome, /test "\$DEPLOY_RESULT" = success/)
})
