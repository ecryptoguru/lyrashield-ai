import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "../../..")
const vaultId =
  "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.KeyVault/vaults/app-only-vault"
const roleId =
  "/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6"
const grants = ["worker-github-app-id", "worker-github-app-private-key"].map((name) => ({
  scope: `${vaultId}/secrets/${name}`,
  roleDefinitionId: roleId,
}))
function check(worker = grants, scanner = [], extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "worker-github-"))
  const log = join(dir, "calls")
  writeFileSync(
    join(dir, "az"),
    `#!/usr/bin/env node
const fs = require('node:fs'); const a = process.argv.slice(2); fs.appendFileSync(process.env.AZ_LOG, a.join(' ')+'\\n');
const value = flag => a[a.indexOf(flag)+1];
if (a.slice(0,2).join(' ')==='keyvault show') console.log(value('--query')==='id' ? process.env.VAULT_ID : process.env.RBAC);
else if (a.slice(0,2).join(' ')==='vm show') console.log(JSON.stringify({principalId:'worker-identity'}));
else if (a.slice(0,2).join(' ')==='containerapp show') console.log(JSON.stringify({principalId:process.env.SCANNER_ID,userAssignedIdentities:process.env.EXTRA_SCANNER ? {extra:{principalId:'extra-identity'}} : undefined}));
else if (a.slice(0,3).join(' ')==='keyvault secret set') { const file=value('--file'); if(value('--vault-name')!=='app-only-vault' || !fs.readFileSync(file,'utf8').startsWith('fixture-') || (fs.statSync(file).mode&0o777)!==0o600 || process.env.GITHUB_APP_ID || process.env.GITHUB_APP_PRIVATE_KEY) process.exit(7); }
else if (a.slice(0,3).join(' ')==='role assignment list') console.log(value('--assignee-object-id')==='worker-identity' ? process.env.WORKER_GRANTS : value('--assignee-object-id')==='extra-identity' ? process.env.EXTRA_SCANNER_GRANTS : process.env.SCANNER_GRANTS);
else process.exit(5);
`,
    { mode: 0o755 }
  )
  writeFileSync(join(dir, "timeout"), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 })
  const args = extra.RUN_SYNC
    ? [".github/scripts/deploy-azure-preflight.sh", "sync-worker-github-credentials"]
    : [".github/scripts/verify-worker-github-access.sh"]
  const result = spawnSync("bash", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      AZ_LOG: log,
      VAULT_ID: vaultId,
      RBAC: "true",
      SCANNER_ID: "scanner-identity",
      WORKER_GRANTS: JSON.stringify(worker),
      SCANNER_GRANTS: JSON.stringify(scanner),
      EXTRA_SCANNER_GRANTS: JSON.stringify([grants[0]]),
      GITHUB_APP_ID: "fixture-app-id",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      AZURE_APP_SECRET_KEY_VAULT_NAME: "app-only-vault",
      AZURE_KEY_VAULT_NAME: "worker-vault",
      AZURE_RESOURCE_GROUP: "fixture",
      AZURE_WORKER_VM_NAME: "worker",
      AZURE_SCANNER_CONTAINER_APP_NAME: "scanner",
      ...extra,
    },
  })
  const calls = (() => {
    try {
      return readFileSync(log, "utf8")
    } catch {
      return ""
    }
  })()
  rmSync(dir, { recursive: true, force: true })
  return { ...result, calls }
}
test("accepts only the two exact VM secret grants and no scanner access", () => {
  const result = check()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.calls, /--include-inherited/)
  assert.doesNotMatch(result.calls, /role assignment create|secret (show|set)/)
})
for (const [name, worker, scanner, extra] of [
  ["missing grant", grants.slice(0, 1)],
  ["vault-wide VM role", [...grants, { scope: vaultId, roleDefinitionId: roleId }]],
  ["inherited VM role", [...grants, { scope: "/subscriptions/fixture", roleDefinitionId: roleId }]],
  [
    "unrelated app secret",
    [...grants, { scope: `${vaultId}/secrets/github-webhook-secret`, roleDefinitionId: roleId }],
  ],
  ["custom role", grants.map((g) => ({ ...g, roleDefinitionId: "custom-role" }))],
  ["conditional grant", grants.map((g) => ({ ...g, condition: "false" }))],
  ["scanner vault role", grants, [{ scope: vaultId, roleDefinitionId: roleId }]],
  ["scanner secret role", grants, [grants[0]]],
  [
    "scanner inherited role",
    grants,
    [{ scope: "/subscriptions/fixture", roleDefinitionId: roleId }],
  ],
  ["non RBAC vault", grants, [], { RBAC: "false" }],
  ["shared vault", grants, [], { AZURE_APP_SECRET_KEY_VAULT_NAME: "worker-vault" }],
  ["shared identity", grants, [], { SCANNER_ID: "worker-identity" }],
  ["missing scanner identity", grants, [], { SCANNER_ID: "None" }],
  ["scanner user-assigned grant", grants, [], { EXTRA_SCANNER: "true" }],
])
  test(`rejects ${name} without mutation`, () => {
    const result = check(worker, scanner, extra)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.calls, /role assignment create|secret (show|set)/)
  })
test("workflow syncs only the worker mint credentials into the app vault", () => {
  const source = readFileSync(join(root, ".github/scripts/deploy-azure-preflight.sh"), "utf8")
  const worker = source.split("step_sync-worker-github-credentials() {")[1]?.split("\n}\n")[0] ?? ""
  assert.match(worker, /verify-worker-github-access.sh/)
  assert.match(worker, /azure_keyvault_sync_env_group "\$AZURE_APP_SECRET_KEY_VAULT_NAME"/)
  assert.match(worker, /worker-github-app-id:GITHUB_APP_ID/)
  assert.match(worker, /worker-github-app-private-key:GITHUB_APP_PRIVATE_KEY/)
  assert.doesNotMatch(worker, /WEBHOOK|CLIENT_SECRET|CLIENT_ID|sync_secret_group/)
  const workflow = readFileSync(join(root, ".github/workflows/deploy-azure-runtime.yml"), "utf8")
  assert.match(
    workflow,
    /run: bash .github\/scripts\/deploy-azure-preflight.sh sync-worker-github-credentials/
  )
  const rollout = readFileSync(join(root, ".github/scripts/deploy-azure-rollout.sh"), "utf8")
  assert.match(rollout, /LYRASHIELD_WORKER_GITHUB_CREDENTIAL_VAULT=/)
  const scanner = rollout.split("step_deploy-scanner-container-app() {")[1]?.split("\n}\n")[0] ?? ""
  assert.doesNotMatch(
    scanner.split("--set-env-vars")[1]?.split("--remove-env-vars")[0] ?? "",
    /GITHUB_APP_PRIVATE_KEY/
  )
})

test("sync writes exactly two private files to the app vault without secret argv", () => {
  const result = check(grants, [], { RUN_SYNC: "1" })
  assert.equal(result.status, 0, result.stderr)
  const writes = result.calls.split("\n").filter((line) => line.startsWith("keyvault secret set"))
  assert.equal(writes.length, 2)
  assert.match(writes[0], /--name worker-github-app-id --file /)
  assert.match(writes[1], /--name worker-github-app-private-key --file /)
  assert.doesNotMatch(
    result.calls + result.stdout + result.stderr,
    /fixture-app-id|fixture-private-key|--value /
  )
})
test("missing VM grant prevents any secret sync", () => {
  const result = check([], [], { RUN_SYNC: "1" })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.calls, /secret set/)
})
test("held recovery validates permissions without rotating existing secrets", () => {
  const result = check(grants, [], { RUN_SYNC: "1", HELD_RECOVERY: "true" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.calls, /role assignment list/)
  assert.doesNotMatch(result.calls, /secret set/)
})
