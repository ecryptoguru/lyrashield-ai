/* eslint-disable security/detect-non-literal-fs-filename -- All paths are test-owned files under a unique temporary directory. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-azure.yml", "utf8")

function runPreparation(t, environment, cleanupStatus = 0) {
  const index = workflow.indexOf("      - name: Reclaim unused hosted runner SDK space\n")
  assert.ok(index >= 0, "image builds need runner disk preparation")
  assert.ok(index < workflow.indexOf("        id: build-web"))
  const step = workflow.slice(index, workflow.indexOf("\n      - name:", index + 1))
  const script = step.split("        run: |\n")[1].replace(/^          /gm, "")
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-runner-disk-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = path.join(directory, "calls")
  writeFileSync(calls, "")
  for (const command of ["sudo", "df"]) {
    writeFileSync(
      path.join(directory, command),
      `#!/bin/bash\nprintf '%s\\n' '${command}' "$@" >> "$TEST_CALLS"\nexit ${command === "sudo" ? cleanupStatus : 0}\n`,
      { mode: 0o700 }
    )
  }
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        TEST_CALLS: calls,
        RUNNER_ENVIRONMENT: environment,
      },
      encoding: "utf8",
    }
  )
  return { ...result, calls: readFileSync(calls, "utf8") }
}

test("hosted image builds reclaim only unused SDKs and report disk space before and after", (t) => {
  const result = runPreparation(t, "github-hosted")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls.trim().split("\n"), [
    "df",
    "-h",
    "/",
    "sudo",
    "rm",
    "-rf",
    "--",
    "/usr/local/lib/android",
    "/usr/share/dotnet",
    "df",
    "-h",
    "/",
  ])
})

for (const environment of ["", "self-hosted"]) {
  test(`disk preparation refuses ${environment || "unknown"} runners before deleting anything`, (t) => {
    const result = runPreparation(t, environment)
    assert.notEqual(result.status, 0)
    assert.equal(result.calls, "")
  })
}

test("disk cleanup failures stop the image build", (t) => {
  const result = runPreparation(t, "github-hosted", 73)
  assert.equal(result.status, 73)
  assert.equal(result.calls.match(/\bdf\b/g)?.length, 1)
})
