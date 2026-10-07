import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
const verifier = readFileSync(".github/scripts/verify-webhook-cutover.mjs", "utf8")
const deploy = workflow.slice(workflow.indexOf("  deploy:\n"))
const steps = [...deploy.matchAll(/^      - name: (.+)$/gm)].map((match, index) => ({
  name: match[1],
  start: match.index,
  index,
}))

function step(name) {
  const index = steps.findIndex((candidate) => candidate.name === name)
  assert.notEqual(index, -1, `Missing deployment step: ${name}`)
  const current = steps[index]
  return {
    index,
    body: deploy.slice(current.start, steps[index + 1]?.start ?? deploy.length),
  }
}

function loginIdentity(body) {
  const action = body.match(/uses: (Azure\/login@[^\s]+)/)?.[1]
  const client = body.match(/client-id: (.+)/)?.[1]
  const tenant = body.match(/tenant-id: (.+)/)?.[1]
  const subscription = body.match(/subscription-id: (.+)/)?.[1]
  assert.ok(action && client && tenant && subscription, "OIDC login identity is incomplete")
  return { action, client, tenant, subscription }
}

test("fresh OIDC identity immediately precedes the late Key Vault verifier", () => {
  assert.match(deploy, /id-token:\s*write/)
  assert.match(deploy, /environment:\s*\n\s+name:\s*azure-production/)
  assert.match(verifier, /const registryToken = run\("az", \[\s*"keyvault",\s*"secret",\s*"show"/)

  const initial = step("Log in to Azure")
  const publicSmoke = step("Smoke production traffic")
  const refresh = step("Refresh Azure OIDC login before installed writer verification")
  const installedWriter = step("Verify installed compatible webhook writer baseline")
  const release = step("Release only original admission after verified held recovery")
  const archive = step("Archive completed held recovery evidence")

  assert.deepEqual(loginIdentity(refresh.body), loginIdentity(initial.body))
  assert.match(
    refresh.body,
    /if: inputs\.webhook_claims_cutover == true \|\| inputs\.held_recovery == true/
  )
  assert.ok(publicSmoke.index < refresh.index)
  assert.equal(refresh.index + 1, installedWriter.index)
  assert.ok(installedWriter.index < release.index && release.index < archive.index)
})

test("long cutover phases renew OIDC before VM boot, release, and archive", () => {
  const initial = step("Log in to Azure")
  const mode = "if: inputs.webhook_claims_cutover == true || inputs.held_recovery == true"
  const bootLogin = step("Refresh Azure OIDC login before webhook worker boot")
  const boot = step("Boot compatible worker before opening webhook ingress")
  const releaseLogin = step("Refresh Azure OIDC login before webhook admission release")
  const firstResume = step("Resume only owned admission after compatible cutover")
  const heldRelease = step("Release only original admission after verified held recovery")
  const archiveLogin = step("Refresh Azure OIDC login before held recovery archive")
  const archive = step("Archive completed held recovery evidence")

  for (const candidate of [bootLogin, releaseLogin, archiveLogin]) {
    assert.deepEqual(loginIdentity(candidate.body), loginIdentity(initial.body))
  }
  assert.ok(bootLogin.body.includes(mode))
  assert.equal(bootLogin.index + 1, boot.index)
  assert.ok(releaseLogin.body.includes(mode))
  assert.equal(releaseLogin.index + 1, firstResume.index)
  assert.equal(firstResume.index + 1, heldRelease.index)
  assert.match(archiveLogin.body, /if: inputs\.held_recovery == true/)
  assert.equal(archiveLogin.index + 1, archive.index)
})

test("failure cleanup renews the same identity after a long held recovery", () => {
  const initial = step("Log in to Azure")
  const refresh = step("Refresh Azure OIDC login before failed held recovery cleanup")
  const cleanup = step("Disable webhook writers after failed held recovery")
  const condition =
    "if: (failure() || cancelled()) && inputs.held_recovery == true && steps.recovery-hold.outcome != 'skipped'"

  assert.deepEqual(loginIdentity(refresh.body), loginIdentity(initial.body))
  assert.ok(refresh.body.includes(condition))
  assert.ok(cleanup.body.includes(condition))
  assert.equal(refresh.index + 1, cleanup.index)
})

test("failure cleanup renews the same identity after a long first cutover", () => {
  const initial = step("Log in to Azure")
  const refresh = step("Refresh Azure OIDC login before failed first-cutover cleanup")
  const cleanup = step("Hold webhook ingress closed after failed maintenance")
  const condition =
    "if: (failure() || cancelled()) && inputs.webhook_claims_cutover == true && steps.webhook-stop.outcome != 'skipped'"

  assert.deepEqual(loginIdentity(refresh.body), loginIdentity(initial.body))
  assert.ok(refresh.body.includes(condition))
  assert.ok(cleanup.body.includes(condition))
  assert.equal(refresh.index + 1, cleanup.index)
})
