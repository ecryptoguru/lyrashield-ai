import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export function assertNamedTestsPassed(report, expectedNames) {
  const tests = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
  for (const expectedName of expectedNames) {
    const matches = tests.filter((test) => test.fullName.endsWith(expectedName))
    if (matches.length !== 1 || matches[0].status !== "passed") {
      throw new Error(
        `Expected exactly one passing test ending with ${JSON.stringify(expectedName)}; got ${JSON.stringify(matches)}`
      )
    }
    console.log(`verified: ${matches[0].fullName}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, ...expectedNames] = process.argv.slice(2)
  if (!reportPath || expectedNames.length === 0) {
    throw new Error("Usage: assert-named-vitest-tests.mjs <report.json> <test-name-suffix> [...]")
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"))
  assertNamedTestsPassed(report, expectedNames)
}
