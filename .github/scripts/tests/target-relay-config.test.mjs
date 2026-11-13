import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

test("relay binding requires explicit activation, enabled existing secret and scoped access", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-relay-config-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, "bin")
  mkdirSync(bin)
  const calls = path.join(directory, "calls")
  writeFileSync(
    path.join(bin, "az"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1 $2 $3" in
  'containerapp show --name') printf '%s\\n' proxy-principal ;;
  'keyvault show --name') printf '%s\\n' /subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault ;;
  'keyvault secret list-versions') printf '%s\\n' "$FAKE_ENABLED" ;;
  'role assignment list') printf '%s\\n' "$FAKE_ROLES" ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o700 }
  )
  const run = (overrides = {}) => {
    writeFileSync(calls, "")
    return spawnSync(
      "bash",
      ["-c", "source .github/scripts/target-relay-config.sh; verify_target_relay_key_vault_access"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_CALLS: calls,
          AZURE_RESOURCE_GROUP: "rg",
          AZURE_KEY_VAULT_NAME: "vault",
          AZURE_EGRESS_PROXY_CONTAINER_APP_NAME: "proxy",
          TARGET_RELAY_ENABLED: "0",
          FAKE_ENABLED: "true",
          FAKE_ROLES: "1",
          ...overrides,
        },
      }
    )
  }
  assert.equal(run().status, 0)
  assert.equal(readFileSync(calls, "utf8"), "")
  assert.equal(run({ TARGET_RELAY_ENABLED: "1" }).status, 0)
  const metadataCalls = readFileSync(calls, "utf8")
  assert.match(metadataCalls, /secrets\/worker-relay-signing-secret/)
  assert.match(
    metadataCalls,
    /keyvault secret list-versions --vault-name vault --name worker-relay-signing-secret/
  )
  assert.doesNotMatch(metadataCalls, /secret (show|set)|role assignment create|--query value/)
  assert.notEqual(run({ TARGET_RELAY_ENABLED: "1", FAKE_ROLES: "0" }).status, 0)
  assert.notEqual(run({ TARGET_RELAY_ENABLED: "1", FAKE_ENABLED: "false" }).status, 0)
  assert.notEqual(run({ TARGET_RELAY_ENABLED: "yes" }).status, 0)
})
