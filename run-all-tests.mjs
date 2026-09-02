import { spawn } from "node:child_process"

/**
 * Run all test suites independently and report every result.
 * This runner runs independent suites in parallel and exits non-zero if any fail.
 */

const allSuites = [
  { name: "core", command: ["vitest", "run", "--exclude", "**/dist/**"] },
  {
    name: "marketing",
    command: ["pnpm", "--filter", "@lyrashield/marketing", "exec", "vitest", "run"],
  },
  // Node 22+ expands the glob natively; no shell needed.
  { name: "motion", command: ["node", "--test", "apps/marketing-motion/tests/*.test.mjs"] },
  { name: "ops", command: ["node", "--test", ".github/scripts/tests/*.test.mjs"] },
]

const requestedSuites = (process.env.LYRASHIELD_TEST_SUITES ?? "core,marketing,motion,ops")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
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
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" })
    // A missing/renamed binary makes spawn emit "error" and "close" never
    // fires — without this handler the Promise would never settle and CI
    // would hang to the job timeout instead of failing fast.
    child.on("error", (error) => {
      console.error(`\n==> ${name} tests could not start: ${error.message}\n`)
      resolve({ name, code: 127 })
    })
    child.on("close", (code) => {
      console.log(`\n==> ${name} tests exited with code ${code ?? 1}\n`)
      resolve({ name, code: code ?? 1 })
    })
  })
}

const results = await Promise.all(suites.map((suite) => run(suite.name, suite.command)))

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
