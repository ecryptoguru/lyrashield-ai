import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { analyzePhpSource, PHP_SOURCE_RULE_VERSION } from "./php-source"
import manifest from "./fixtures/php-source/manifest.json"

describe("versioned PHP source benchmark (passive, built-in only)", () => {
  it("pins the rule revision", () => {
    expect(manifest.ruleVersion).toBe(PHP_SOURCE_RULE_VERSION)
  })

  it.each(manifest.cases)("$kind: $file", (fixture) => {
    const source = readFileSync(
      new URL(`./fixtures/php-source/${fixture.file}`, import.meta.url),
      "utf8"
    )
    const result = analyzePhpSource(source, fixture.file)
    expect([...new Set(result.findings.map((finding) => finding.cwe))].sort()).toEqual(
      [...fixture.expectedCwes].sort()
    )
    expect(result.issues.join(" ")).toContain("unassessed")
    // This is a reproducible local rule receipt, never exploit/runtime verification.
    console.info(
      JSON.stringify({
        benchmark: "php-source",
        ruleVersion: PHP_SOURCE_RULE_VERSION,
        fixture: fixture.file,
        fixtureSha256: createHash("sha256").update(source).digest("hex"),
        expectedCwes: fixture.expectedCwes,
        findings: result.findings.map((finding) => ({
          id: finding.id,
          cwe: finding.cwe,
          provenance: finding.dependency_metadata,
        })),
        coverageIssues: result.issues,
      })
    )
  })
})
