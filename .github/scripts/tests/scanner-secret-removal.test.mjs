import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

test("scanner cleanup fails closed on failed, partial or malformed secret readback", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scanner-secrets-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(
    join(root, "az"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == *'secret remove'* ]]; then touch "$CALLS.removed"; exit 0; fi
if [ -f "$CALLS.removed" ]; then
  if [ "$AFTER_REPLY" = failure ]; then echo PRIVATE_AZURE_ERROR >&2; exit 42; fi
  printf '%s\\n' "$AFTER_REPLY"; exit 0
fi
if [[ "$REPLY" == failure ]]; then echo PRIVATE_AZURE_ERROR >&2; exit 42; fi
printf '%s\\n' "$REPLY"
`,
    { mode: 0o755 }
  )
  for (const [reply, afterReply, succeeds] of [
    ["failure", "[]", false],
    ["null", "[]", false],
    ["{}", "[]", false],
    ['[{"name":null}]', "[]", false],
    ["[]", "[]", true],
    ['[{"name":"github-app-id"},{"name":"database-url"}]', '[{"name":"database-url"}]', true],
    ['[{"name":"github-app-id"}]', '[{"name":"github-app-id"}]', false],
    ['[{"name":"github-app-id"}]', "{}", false],
    ['[{"name":"github-app-id"}]', "failure", false],
  ]) {
    const calls = join(root, "calls")
    rmSync(calls + ".removed", { force: true })
    writeFileSync(calls, "")
    const result = spawnSync(
      "bash",
      [".github/scripts/deploy-azure-rollout.sh", "remove-excess-scanner-secrets"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          SCANNER_NAME: "scanner",
          RG: "rg",
          CALLS: calls,
          REPLY: reply,
          AFTER_REPLY: afterReply,
        },
      }
    )
    assert.equal(result.status === 0, succeeds, `${reply}: ${result.stderr}`)
    assert.equal((result.stdout + result.stderr).includes("PRIVATE_AZURE_ERROR"), false)
    const recorded = readFileSync(calls, "utf8")
    assert.equal(recorded.includes("secret remove"), reply.includes('"github-app-id"'))
    assert.equal(
      recorded.includes("--secret-names github-app-id"),
      reply.includes('"github-app-id"')
    )
    assert.equal(recorded.includes("--secret-names database-url"), false)
    assert.doesNotMatch(recorded, /revision|ingress|containerapp update|worker/)
  }
})
