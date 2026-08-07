import { spawn } from "node:child_process"

/**
 * Run all three test suites independently and report every result.
 *
 * The previous `pnpm test` chained the three suites with `&&`, which
 * short-circuits and silently skips marketing/motion when core fails.
 * This runner always executes all three and exits non-zero if any failed.
 */

const suites = [
  { name: "core", command: ["vitest", "run", "--exclude", "**/dist/**"] },
  { name: "marketing", command: ["pnpm", "--filter", "@lyrashield/marketing", "exec", "vitest", "run"] },
  // Node 22+ expands the glob natively; no shell needed.
  { name: "motion", command: ["node", "--test", "apps/marketing-motion/tests/*.test.mjs"] },
]

function run(name, command) {
  return new Promise((resolve) => {
    console.log(`\n==> Starting ${name} tests: ${command.join(" ")}\n`)
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" })
    child.on("close", (code) => {
      console.log(`\n==> ${name} tests exited with code ${code ?? 1}\n`)
      resolve({ name, code: code ?? 1 })
    })
  })
}

const results = []
for (const suite of suites) {
  results.push(await run(suite.name, suite.command))
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
