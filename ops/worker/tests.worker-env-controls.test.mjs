import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const library = fileURLToPath(new URL("./worker-env.sh", import.meta.url))
function args(controls) {
  const dir = mkdtempSync(join(tmpdir(), "worker-controls-"))
  try {
    const config = join(dir, "runtime.conf")
    writeFileSync(
      config,
      ["LYRASHIELD_WORKER_IMAGE=worker", "LYRASHIELD_SANDBOX_IMAGE=sandbox", ...controls].join("\n")
    )
    return spawnSync(
      "sh",
      [
        "-eu",
        "-c",
        `docker() { printf '%040d\\n' 1; }
. "$1"
lyrashield_worker_env_args "$2" /dev/null`,
        "test",
        library,
        config,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          LLM_API_MODE: "chat_completions",
          LYRASHIELD_PENDING_HTTP_EVIDENCE: "1",
        },
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
test("trusted Docker arguments forward bounded controls, preserving inheritance when absent", () => {
  for (const controls of [
    [],
    ["LYRASHIELD_RUN_RECORD_V1_1=1", "LYRASHIELD_PENDING_HTTP_EVIDENCE=0"],
    ["LLM_API_MODE=responses"],
    ["DEDUPE_LLM_API_MODE=auto"],
    [
      "LYRASHIELD_RUN_RECORD_V1_1=1",
      "LYRASHIELD_PENDING_HTTP_EVIDENCE=1",
      "LLM_API_MODE=responses",
      "DEDUPE_LLM_API_MODE=chat_completions",
    ],
  ]) {
    const result = args(controls)
    assert.equal(result.status, 0, result.stderr)
    const emitted = result.stdout.trim().split("\n")
    for (const entry of controls) assert.ok(emitted.includes(`--env ${entry}`))
    if (!controls.some((x) => x.startsWith("LLM_API_MODE=")))
      assert.doesNotMatch(result.stdout, /--env LLM_API_MODE=/)
    if (!controls.some((x) => x.startsWith("DEDUPE_")))
      assert.doesNotMatch(result.stdout, /DEDUPE_LLM_API_MODE=/)
    if (!controls.length)
      for (const key of ["LYRASHIELD_RUN_RECORD_V1_1", "LYRASHIELD_PENDING_HTTP_EVIDENCE"])
        assert.ok(emitted.includes(`--env ${key}=0`))
  }
})
for (const value of [
  "LYRASHIELD_PENDING_HTTP_EVIDENCE=1",
  "LYRASHIELD_RUN_RECORD_V1_1=true",
  "LLM_API_MODE='responses --privileged'",
  "DEDUPE_LLM_API_MODE=''",
]) {
  test(`rejects invalid trusted config before emitting arguments: ${value}`, () => {
    const result = args([value])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  })
}
