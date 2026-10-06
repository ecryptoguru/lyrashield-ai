import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

for (const coverage of ["0", "1"]) {
  test(`core CI failure prints its name and stack with coverage=${coverage}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "lyrashield-test-diagnostics-"))
    try {
      const vitest = join(dir, "vitest")
      writeFileSync(
        vitest,
        `#!${process.execPath}
const { writeFileSync } = require("node:fs")
const reportPath = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13)
if (!reportPath || process.argv.includes("--coverage") !== (process.env.LYRASHIELD_TEST_COVERAGE === "1")) process.exit(2)
if (!process.argv.includes("--reporter=default") || !process.argv.includes("--reporter=json")) process.exit(2)
console.error("Native Vitest diagnostic: Test timed out in 5000ms.")
writeFileSync(reportPath, JSON.stringify({ testResults: [{ name: "sample.test.ts", assertionResults: [{ fullName: "sample suite reports the failing case", status: "failed", failureMessages: ["Error: expected true\\n    at sample.test.ts:4:3"] }] }] }))
process.exit(1)
`
      )
      chmodSync(vitest, 0o755)
      const runner = fileURLToPath(new URL("../../../run-all-tests.mjs", import.meta.url))
      const result = spawnSync(process.execPath, [runner], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...process.env,
          CI: "true",
          RUNNER_TEMP: dir,
          LYRASHIELD_TEST_SUITES: "core",
          LYRASHIELD_TEST_COVERAGE: coverage,
          PATH: `${dir}:${process.env.PATH}`,
        },
        encoding: "utf8",
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /sample suite reports the failing case/)
      assert.match(result.stderr, /at sample\.test\.ts:4:3/)
      assert.match(result.stderr, /Native Vitest diagnostic: Test timed out in 5000ms/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("CI suites that omit core do not try to read its report", () => {
  const dir = mkdtempSync(join(tmpdir(), "lyrashield-test-no-core-"))
  try {
    const pnpm = join(dir, "pnpm")
    writeFileSync(
      pnpm,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.SUITE_CALLS, "marketing\\n"); process.exit(0)\n`
    )
    chmodSync(pnpm, 0o755)
    const runner = fileURLToPath(new URL("../../../run-all-tests.mjs", import.meta.url))
    const result = spawnSync(process.execPath, [runner], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: {
        ...process.env,
        CI: "true",
        RUNNER_TEMP: dir,
        LYRASHIELD_TEST_SUITES: "marketing,marketing",
        SUITE_CALLS: join(dir, "calls"),
        PATH: `${dir}:${process.env.PATH}`,
      },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /Could not read core Vitest report/)
    assert.equal(readFileSync(join(dir, "calls"), "utf8"), "marketing\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("requested test suites execute sequentially and report wall time", () => {
  const dir = mkdtempSync(join(tmpdir(), "lyrashield-test-order-"))
  try {
    for (const command of ["pnpm", "vitest"]) {
      const executable = join(dir, command)
      writeFileSync(
        executable,
        `#!${process.execPath}\nconst fs=require("node:fs"); const name=process.argv[1].split("/").at(-1); fs.appendFileSync(process.env.SUITE_ORDER, "start:"+name+"\\n"); setTimeout(()=>fs.appendFileSync(process.env.SUITE_ORDER, "end:"+name+"\\n"), 40)\n`
      )
      chmodSync(executable, 0o755)
    }
    const runner = fileURLToPath(new URL("../../../run-all-tests.mjs", import.meta.url))
    const result = spawnSync(process.execPath, [runner], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: {
        ...process.env,
        CI: "",
        RUNNER_TEMP: dir,
        LYRASHIELD_TEST_SUITES: "marketing,core",
        SUITE_ORDER: join(dir, "order"),
        PATH: `${dir}:${process.env.PATH}`,
      },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /marketing tests exited with code 0 after \d+\.\d+s/)
    assert.match(result.stdout, /core tests exited with code 0 after \d+\.\d+s/)
    assert.deepEqual(readFileSync(join(dir, "order"), "utf8").trim().split("\n"), [
      "start:pnpm",
      "end:pnpm",
      "start:vitest",
      "end:vitest",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
