import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("Container Apps update retry uses bounded exponential backoff", (t) => {
  const containerAppHelper = readFileSync("ops/deployment/containerapp.sh", "utf8")
  assert.match(containerAppHelper, /ca_retry_update\(\) \{/)

  const directory = mkdtempSync(join(tmpdir(), "lyra-azure-update-retry-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const callsPath = join(directory, "calls")
  const sleepsPath = join(directory, "sleeps")
  const mockBin = join(directory, "bin")
  const scriptPath = join(directory, "test.sh")
  mkdirSync(mockBin)
  writeFileSync(
    join(mockBin, "fakeaz"),
    `#!/usr/bin/env bash
set -eu
calls=0
[ ! -f "$AZURE_UPDATE_RETRY_CALLS" ] || calls=$(cat "$AZURE_UPDATE_RETRY_CALLS")
calls=$((calls + 1))
printf '%s' "$calls" > "$AZURE_UPDATE_RETRY_CALLS"
if [ "$calls" -lt 5 ]; then
  echo 'ERROR: ContainerAppOperationInProgress'
  exit 1
fi
echo success
`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(mockBin, "sleep"),
    `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$AZURE_UPDATE_RETRY_SLEEPS"
`,
    { mode: 0o755 }
  )

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
source "$CONTAINER_APP_HELPER"
ca_retry_update fakeaz update
`
  )

  const output = execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH}`,
      AZURE_UPDATE_RETRY_CALLS: callsPath,
      AZURE_UPDATE_RETRY_SLEEPS: sleepsPath,
      CONTAINER_APP_HELPER: process.cwd() + "/ops/deployment/containerapp.sh",
    },
  })

  assert.equal(output.trim(), "success")
  assert.equal(readFileSync(callsPath, "utf8"), "5")
  assert.deepEqual(readFileSync(sleepsPath, "utf8").trim().split("\n"), ["5", "10", "20", "30"])
})
