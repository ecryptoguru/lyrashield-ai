import { describe, expect, it } from "vitest"
import { parseSarifReport, SARIF_IMPORT_VERSION } from "./sarif-import"

const SARIF_DOC = {
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "semgrep",
          version: "1.45.0",
          rules: [
            {
              id: "javascript.express.security.audit.xss",
              properties: { cwe: "CWE-79", tags: ["OWASP-A03"] },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "javascript.express.security.audit.xss",
          level: "error",
          message: { text: "Detected XSS in res.render" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/routes/search.ts" },
                region: { startLine: 42, endLine: 42 },
              },
            },
          ],
        },
        {
          ruleId: "no-message-no-loc",
          level: "note",
          message: { text: "Informational" },
        },
        {
          level: "warning",
          // no ruleId and no message — must be rejected
        },
      ],
    },
  ],
}

describe("parseSarifReport", () => {
  it("normalizes results into imported finding records", () => {
    const result = parseSarifReport(SARIF_DOC, "target-1")
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.toolName).toBe("semgrep")
    expect(result.findings).toHaveLength(2)
    expect(result.rejected).toBe(1)
    expect(result.resultCount).toBe(3)

    const first = result.findings[0]!
    expect(first.severity).toBe("HIGH")
    expect(first.cwe).toBe("CWE-79")
    expect(first.file).toBe("src/routes/search.ts")
    expect(first.startLine).toBe(42)
    expect(first.sarifRuleId).toBe("javascript.express.security.audit.xss")
    expect(first.dedupeKey).toMatch(/^[0-9a-f]{32}$/)
  })

  it("produces stable dedupe keys for identical input", () => {
    const a = parseSarifReport(SARIF_DOC, "target-1")
    const b = parseSarifReport(SARIF_DOC, "target-1")
    if ("error" in a || "error" in b) throw new Error("parse failed")
    expect(a.findings[0]!.dedupeKey).toBe(b.findings[0]!.dedupeKey)
  })

  it("keys differ across targets", () => {
    const a = parseSarifReport(SARIF_DOC, "target-1")
    const b = parseSarifReport(SARIF_DOC, "target-2")
    if ("error" in a || "error" in b) throw new Error("parse failed")
    expect(a.findings[0]!.dedupeKey).not.toBe(b.findings[0]!.dedupeKey)
  })

  it("rejects non-SARIF payloads", () => {
    expect("error" in (parseSarifReport({ hello: 1 }, "t") as { error: string })).toBe(true)
    expect(
      "error" in (parseSarifReport("not json{{{", "t") as { error: string })
    ).toBe(true)
    expect(
      "error" in (parseSarifReport({ version: "1.0.0", runs: [] }, "t") as { error: string })
    ).toBe(true)
  })

  it("carries the import version in the payload for provenance", () => {
    const result = parseSarifReport(SARIF_DOC, "target-1")
    if ("error" in result) throw new Error("parse failed")
    expect(result.findings[0]!.payload.importVersion).toBe(SARIF_IMPORT_VERSION)
    expect(result.findings[0]!.payload.toolName).toBe("semgrep")
  })
})
