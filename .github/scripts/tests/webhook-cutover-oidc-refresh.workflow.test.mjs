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

function foldedCondition(body) {
  const value = body.match(/if: >\n([\s\S]*?)\n        (?:uses:|env:)/)?.[1]
  assert.ok(value, "Expected a folded workflow condition")
  return value.replace(/\s+/g, " ").trim()
}

function evaluateCondition(body, inputs, steps, failed) {
  const singleLine = body.match(/^        if: (.+)$/m)?.[1]
  const condition = singleLine === ">" ? foldedCondition(body) : singleLine
  assert.ok(condition, "Missing workflow condition")
  const expression = condition.replace(
    /steps\.([a-z][a-z0-9-]*)/g,
    (_, name) => `steps[${JSON.stringify(name)}]`
  )
  return Function(
    "inputs",
    "steps",
    "failure",
    `return (${expression})`
  )(inputs, steps, () => failed)
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

test("ordinary migration renews OIDC before Key Vault secret synchronization", () => {
  const initial = step("Log in to Azure")
  const migration = step("Run database migrations")
  const refresh = step("Refresh Azure OIDC login before post-migration Key Vault sync")
  const sync = step("Sync BullMQ Redis secret to worker Key Vault")

  assert.deepEqual(loginIdentity(refresh.body), loginIdentity(initial.body))
  assert.match(refresh.body, /if: inputs\.held_recovery != true/)
  assert.ok(migration.index < refresh.index)
  assert.equal(refresh.index + 1, sync.index)
})

test("ordinary worker promotion and failure cleanup renew the same OIDC identity", () => {
  const initial = step("Log in to Azure")
  const promoteLogin = step("Refresh Azure OIDC login before ordinary worker promotion")
  const promote = step("Promote verified worker digest on VM")
  const cleanupLogin = step("Refresh Azure OIDC login before ordinary failure cleanup")
  const rollback = step("Roll back production traffic on health failure")
  const deactivate = step("Deactivate zero-traffic candidates after failed rollout")

  for (const candidate of [promoteLogin, cleanupLogin]) {
    assert.deepEqual(loginIdentity(candidate.body), loginIdentity(initial.body))
  }
  assert.match(
    promoteLogin.body,
    /if: inputs\.held_recovery != true && inputs\.webhook_claims_cutover != true/
  )
  assert.equal(promoteLogin.index + 1, promote.index)
  assert.equal(cleanupLogin.index + 1, rollback.index)
  assert.equal(foldedCondition(cleanupLogin.body), foldedCondition(deactivate.body))
})

test("a failed ordinary worker login triggers rollback and every applicable cleanup", () => {
  const outcomes = [
    "deploy-app",
    "deploy-scanner",
    "deploy-egress-proxy",
    "smoke-candidates",
    "worker-preflight",
    "promote",
    "smoke-public",
    "ordinary-worker-login",
    "worker-vm",
  ]
  const steps = Object.fromEntries(outcomes.map((name) => [name, { outcome: "success" }]))
  steps["ordinary-worker-login"].outcome = "failure"
  steps["deploy-app"].outputs = { previous_client_cert_mode: "required" }

  for (const name of [
    "Refresh Azure OIDC login before ordinary failure cleanup",
    "Roll back production traffic on health failure",
    "Restore prior ingress mode after failed rollout",
    "Deactivate zero-traffic candidates after failed rollout",
  ]) {
    const body = step(name).body
    assert.equal(
      evaluateCondition(body, { held_recovery: false, webhook_claims_cutover: false }, steps, true),
      true,
      name
    )
    assert.equal(
      evaluateCondition(body, { held_recovery: true, webhook_claims_cutover: false }, steps, true),
      false,
      name
    )
    assert.equal(
      evaluateCondition(
        body,
        { held_recovery: false, webhook_claims_cutover: false },
        steps,
        false
      ),
      false,
      name
    )
  }
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
