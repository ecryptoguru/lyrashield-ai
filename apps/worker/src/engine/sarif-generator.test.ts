import { describe, it, expect } from "vitest"
import { generateSarifReport } from "./sarif-generator"

const findings = [
  {
    id: "f1",
    title: "SQL Injection",
    summary: "SQL injection in login form",
    severity: "CRITICAL" as const,
    cwe: "CWE-89",
    cve: "CVE-2024-1234",
    verified: true,
    cvssScore: 9.8,
    target: { name: "web-app", url: "https://example.com" },
  },
  {
    id: "f2",
    title: "XSS",
    summary: "Stored XSS in comments",
    severity: "HIGH" as const,
    cwe: "CWE-79",
    verified: false,
    target: { name: "web-app", url: "https://example.com" },
  },
]

describe("generateSarifReport", () => {
  it("generates a valid SARIF 2.1.0 report", () => {
    const report = generateSarifReport(findings, {
      name: "LyraShield",
      version: "0.1.0",
    })
    expect(report.version).toBe("2.1.0")
    expect(report.runs).toHaveLength(1)
    expect(report.runs[0]!.tool.driver.name).toBe("LyraShield")
    expect(report.runs[0]!.tool.driver.version).toBe("0.1.0")
  })

  it("creates rules from findings", () => {
    const report = generateSarifReport(findings, { name: "LyraShield" })
    const rules = report.runs[0]!.tool.driver.rules!
    expect(rules).toHaveLength(2)
    expect(rules[0]!.id).toBe("CVE-2024-1234")
    expect(rules[1]!.id).toBe("CWE-79")
  })

  it("maps severity to SARIF level", () => {
    const report = generateSarifReport(findings, { name: "LyraShield" })
    const results = report.runs[0]!.results
    expect(results[0]!.level).toBe("error") // CRITICAL
    expect(results[1]!.level).toBe("error") // HIGH
  })

  it("includes locations when target is provided", () => {
    const report = generateSarifReport(findings, { name: "LyraShield" })
    const results = report.runs[0]!.results
    expect(results[0]!.locations).toBeDefined()
    expect(results[0]!.locations![0]!.physicalLocation.artifactLocation.uri).toBe(
      "https://example.com"
    )
  })

  it("includes properties with finding id and verified status", () => {
    const report = generateSarifReport(findings, { name: "LyraShield" })
    const props = report.runs[0]!.results[0]!.properties!
    expect(props.id).toBe("f1")
    expect(props.verified).toBe(true)
  })

  it("generates help URI for CWE rules", () => {
    const report = generateSarifReport(findings, { name: "LyraShield" })
    const rules = report.runs[0]!.tool.driver.rules!
    const cweRule = rules.find((r) => r.id === "CWE-79")
    expect(cweRule!.helpUri).toContain("cwe.mitre.org")
    expect(cweRule!.helpUri).toContain("79")
  })

  it("uses the LyraShield prefix for generated rule IDs", () => {
    const report = generateSarifReport(
      [
        {
          id: "abc12345",
          title: "Unclassified finding",
          summary: "No external identifier is available",
          severity: "LOW" as const,
          verified: false,
        },
      ],
      { name: "LyraShield" }
    )

    expect(report.runs[0]!.results[0]!.ruleId).toBe("lyrashield-abc12345")
  })
})
