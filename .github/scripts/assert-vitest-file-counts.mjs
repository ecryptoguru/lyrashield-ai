import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Service runs must execute every required fixture, not merely discover files.
export function assertFileCounts(report, expectations) {
  for (const [suffix, minimum] of expectations) {
    const files = (report.testResults ?? []).filter((file) => file.name.endsWith(suffix))
    if (files.length !== 1) throw new Error(`Expected one report for ${suffix}`)
    const tests = files[0].assertionResults ?? []
    if (tests.length < minimum || tests.some((test) => test.status !== "passed")) {
      throw new Error(
        `Expected at least ${minimum} passing cases and no skips/failures for ${suffix}`
      )
    }
    console.log(`verified: ${suffix}: ${tests.length} passed, no skipped cases`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, ...specs] = process.argv.slice(2)
  if (!reportPath || specs.length === 0)
    throw new Error("Expected report.json file.ts=minimum [...]")
  const expectations = specs.map((spec) => {
    const [suffix, count] = spec.split("=")
    const minimum = Number(count)
    if (!suffix || !Number.isInteger(minimum) || minimum < 1)
      throw new Error(`Invalid fixture count ${spec}`)
    return [suffix, minimum]
  })
  assertFileCounts(JSON.parse(readFileSync(reportPath, "utf8")), expectations)
}
