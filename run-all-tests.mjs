import { spawn } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertNamedTestsPassed } from "./.github/scripts/assert-named-vitest-tests.mjs"

/**
 * Run each requested suite independently, in order, and report every result.
 * Exits non-zero if any suite fails.
 */

const isCi = process.env.CI === "true"
const coreReportPath = isCi
  ? join(process.env.RUNNER_TEMP ?? tmpdir(), `lyrashield-core-vitest-${process.pid}.json`)
  : null
const coreCommand = ["vitest", "run", "--exclude", "**/dist/**"]
if (coreReportPath) {
  // Keep Vitest's native diagnostics: JSON can replace timeout details with
  // STACK_TRACE_ERROR. The JSON report still powers the named-test guard.
  coreCommand.push("--reporter=default", "--reporter=json", `--outputFile=${coreReportPath}`)
}
if (process.env.LYRASHIELD_TEST_COVERAGE === "1") {
  coreCommand.push("--coverage")
}

const allSuites = [
  { name: "core", command: coreCommand },
  {
    name: "marketing",
    command: ["pnpm", "--filter", "@lyrashield/marketing", "exec", "vitest", "run"],
  },
  // Node 22+ expands the glob natively; no shell needed.
  { name: "motion", command: ["node", "--test", "apps/marketing-motion/tests/*.test.mjs"] },
  {
    name: "ops",
    command: [
      "node",
      "--test",
      ...(process.env.LYRASHIELD_OPS_RUNTIME_ALREADY_VERIFIED === "1"
        ? readdirSync(".github/scripts/tests")
            .filter(
              (file) =>
                file.endsWith(".test.mjs") &&
                !["webhook-catalog.runtime.test.mjs", "webhook-queue.runtime.test.mjs"].includes(
                  file
                )
            )
            .sort()
            .map((file) => `.github/scripts/tests/${file}`)
        : [".github/scripts/tests/*.test.mjs"]),
    ],
  },
]

const requestedSuites = [
  ...new Set(
    (process.env.LYRASHIELD_TEST_SUITES ?? "core,marketing,motion,ops")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  ),
]
const suitesByName = new Map(allSuites.map((suite) => [suite.name, suite]))
const suites = requestedSuites.map((name) => {
  const suite = suitesByName.get(name)
  if (!suite) throw new Error(`Unknown test suite: ${name}`)
  return suite
})

if (suites.length === 0) throw new Error("At least one test suite is required")

function run(name, command) {
  return new Promise((resolve) => {
    console.log(`\n==> Starting ${name} tests: ${command.join(" ")}\n`)
    const startedAt = performance.now()
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" })
    let settled = false
    const finish = (code, message) => {
      if (settled) return
      settled = true
      const durationSeconds = (performance.now() - startedAt) / 1000
      console.log(`\n==> ${message} after ${durationSeconds.toFixed(2)}s\n`)
      resolve({ name, code, durationSeconds })
    }
    // A missing/renamed binary makes spawn emit "error" and "close" never
    // fires — without this handler the Promise would never settle and CI
    // would hang to the job timeout instead of failing fast.
    child.on("error", (error) => {
      finish(127, `${name} tests could not start: ${error.message}`)
    })
    child.on("close", (code, signal) => {
      finish(code ?? 1, `${name} tests exited with code ${code ?? `signal ${signal}`}`)
    })
  })
}

// The combined run starts four independent test processes at once. Two local
// combined-run timeouts passed when isolated; contention during imports and
// database setup is plausible but not proven. Run suites sequentially first
// and report their wall times while retaining every suite and assertion.
const results = []
for (const suite of suites) {
  results.push(await run(suite.name, suite.command))
}
const coreResult = results.find((r) => r.name === "core")

if (coreReportPath && coreResult && coreResult.code !== 0) {
  try {
    const report = JSON.parse(readFileSync(coreReportPath, "utf8"))
    for (const file of report.testResults ?? []) {
      for (const test of file.assertionResults ?? []) {
        if (test.status === "failed") {
          console.error(`\n==> ${test.fullName || test.title || file.name}`)
          for (const message of test.failureMessages ?? []) console.error(message)
        }
      }
      if (file.message) console.error(`\n==> ${file.name}\n${file.message}`)
    }
  } catch (error) {
    console.error(`\n==> Could not read core Vitest report at ${coreReportPath}: ${error.message}`)
  }
}

if (coreReportPath && coreResult?.code === 0) {
  try {
    const report = JSON.parse(readFileSync(coreReportPath, "utf8"))
    assertNamedTestsPassed(report, [
      "renews month two once, without a workspace, preserving month-one consumption",
      "denies a coworker even when the workspace matches",
      "binds a task to the recorded operation row — and resolves it fresh every time",
      "reads every target's current verdict in one batched call under the restricted runtime role",
      "accounts for every live public RLS table and verifies enforcement flags",
      "sees the expired account and downgrades the workspace (getSystemPrisma sweep)",
      "the guard count sees the running scan for the schedule's workspace+target",
      "releases the reservation when the provider definitely fails",
      "returns an entry whose only matching word is in the topic column",
      "retrieves the expected public source in the top five for at least 90% of 60 questions",
      "executes atomic cleanup, count, TTL, and one warmed EVALSHA per operation",
      "denies a changed input under the same idempotency key without altering the ledger",
    ])
  } catch (error) {
    console.error("\n==> core environment-gated test guard failed:", error)
    results.push({ name: "core environment-gated test guard", code: 1 })
  }
}

const failed = results.filter((r) => r.code !== 0)
if (failed.length > 0) {
  console.error("\nFAILED test suites:")
  for (const r of failed) {
    console.error(`  - ${r.name}: exit code ${r.code}`)
  }
  process.exit(1)
}

console.log("\nAll test suites passed.")
process.exit(0)
