import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const library = fileURLToPath(new URL("./worker-env.sh", import.meta.url))
function args(controls, sbom = sbomBaseControls, inherited = {}) {
  const dir = mkdtempSync(join(tmpdir(), "worker-controls-"))
  try {
    const config = join(dir, "runtime.conf")
    writeFileSync(
      config,
      [
        "LYRASHIELD_WORKER_IMAGE=worker",
        "LYRASHIELD_SANDBOX_IMAGE=sandbox",
        ...sbom,
        ...controls,
      ].join("\n")
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
          ...inherited,
        },
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("inherited SBOM evidence cannot supply values missing from runtime.conf", () => {
  const inherited = Object.fromEntries(
    sbomBaseControls.map((line) => {
      const index = line.indexOf("=")
      return [line.slice(0, index), line.slice(index + 1)]
    })
  )
  for (let omit = 0; omit < sbomBaseControls.length; omit++) {
    const result = args(
      [],
      sbomBaseControls.filter((_, index) => index !== omit),
      inherited
    )
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  }
})

for (const key of [
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF",
]) {
  for (const whitespace of ["\n", "\r", "\t", " "]) {
    test(`rejects Docker argument splitting in ${key}: ${JSON.stringify(whitespace)}`, () => {
      const baseline = sbomBaseControls.find((entry) => entry.startsWith(key + "="))
      const value = baseline.slice(key.length + 1)
      const result = args([`${key}='${value}${whitespace}--privileged'`])
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, "")
    })
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

const sbomBaseControls = [
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH=/var/lib/lyrashield/worker/sbom-evidence/coverage.json",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH=/var/lib/lyrashield/worker/sbom-evidence/coverage-predicate.json",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO=ecryptoguru/lyrashield-engine",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF=refs/heads/main",
  `LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION=${"a".repeat(40)}`,
  `LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION=${"b".repeat(40)}`,
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID=42487812345",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT=2",
]
test("SBOM coverage evidence is required and emitted when valid", () => {
  const result = args([])
  assert.equal(result.status, 0, result.stderr)
  const emitted = result.stdout.trim().split("\n")
  for (const entry of sbomBaseControls) assert.ok(emitted.includes(`--env ${entry}`), entry)
})

test("SBOM coverage evidence missing fails before emitting arguments", () => {
  for (let omit = 0; omit < sbomBaseControls.length; omit++) {
    const result = args(
      [],
      sbomBaseControls.filter((_, index) => index !== omit)
    )
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  }
})

for (const bad of [
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH=relative/coverage.json",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH=relative/predicate.json",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO=lyrashield-engine",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF=main",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION=not-a-sha",
  `LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION=${"b".repeat(39)}`,
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID=0",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT=abc",
  "LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO='two words'",
]) {
  test(`rejects invalid SBOM coverage config: ${bad}`, () => {
    // The invalid entry is sourced after the valid baseline, matching an
    // operator overriding one value in a complete runtime.conf.
    const result = args([bad])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  })
}
