import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

test("egress rollout preflight requires secret-scoped access and the system identity reference", (t) => {
  const preflight = readFileSync(".github/scripts/deploy-azure-preflight.sh", "utf8")
  assert.match(
    preflight,
    /step_prepare-private-registry-and-zero-downtime-rollout\(\) \{\n  verify_egress_proxy_key_vault_access\n/
  )
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-egress-preflight-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, "bin")
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, "az"),
    `#!/usr/bin/env bash
case "$1 $2 $3" in
  "containerapp show --name")
    case "$*" in
      *identity.principalId*) printf 'proxy-principal\\n' ;;
      *keyVaultUrl*) printf '%s\\n' "$FAKE_SECRET_REF" ;;
      *configuration.secrets*identity*) printf '%s\\n' "$FAKE_SECRET_IDENTITY" ;;
      *) exit 91 ;;
    esac ;;
  "keyvault show --name") printf '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault\\n' ;;
  "role assignment list")
    case "$*" in
      *"--scope /subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault/secrets/worker-egress-proxy-secret"*"--assignee-object-id proxy-principal"*) printf '%s\\n' "$FAKE_ROLE_COUNT" ;;
      *) exit 93 ;;
    esac ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o700 }
  )

  const run = (overrides = {}) =>
    spawnSync(
      "bash",
      [".github/scripts/deploy-azure-preflight.sh", "verify-egress-proxy-key-vault-access"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AZURE_RESOURCE_GROUP: "rg",
          AZURE_KEY_VAULT_NAME: "vault",
          AZURE_EGRESS_PROXY_CONTAINER_APP_NAME: "proxy",
          FAKE_ROLE_COUNT: "1",
          FAKE_SECRET_REF: "https://vault.vault.azure.net/secrets/worker-egress-proxy-secret",
          FAKE_SECRET_IDENTITY: "system",
          ...overrides,
        },
      }
    )

  assert.equal(run().status, 0)
  const noRole = run({ FAKE_ROLE_COUNT: "0" })
  assert.equal(noRole.status, 1)
  assert.match(noRole.stdout, /Key Vault Secrets User/)
  const wrongReference = run({
    FAKE_SECRET_REF: "https://other.vault.azure.net/secrets/worker-egress-proxy-secret",
  })
  assert.equal(wrongReference.status, 1)
  assert.match(wrongReference.stdout, /must reference worker-egress-proxy-secret/)
  assert.equal(run({ FAKE_SECRET_IDENTITY: "user" }).status, 1)
  assert.equal(run({ AZURE_EGRESS_PROXY_CONTAINER_APP_NAME: "" }).status, 0)
})
