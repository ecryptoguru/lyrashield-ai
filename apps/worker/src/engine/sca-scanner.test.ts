import { describe, it, expect } from "vitest"
import {
  normalizeScaFinding,
  parseScaOutput,
  sortBySeverity,
  deduplicateScaFindings,
  type DependencyVulnerability,
} from "./sca-scanner"

const targetId = "target-123"

const sampleDep: DependencyVulnerability = {
  package: "lodash",
  version: "4.17.20",
  ecosystem: "npm",
  severity: "high",
  cve: "CVE-2021-23337",
  cwe: "CWE-1035",
  cvss: 7.2,
  patchedVersion: "4.17.21",
  description: "Command injection vulnerability in lodash",
  advisoryUrl: "https://nvd.nist.gov/vuln/detail/CVE-2021-23337",
}

describe("normalizeScaFinding", () => {
  it("converts a dependency vulnerability to EngineVulnerability format", () => {
    const result = normalizeScaFinding(sampleDep, targetId)
    expect(result.title).toContain("lodash")
    expect(result.title).toContain("4.17.20")
    expect(result.severity).toBe("high")
    expect(result.cve).toBe("CVE-2021-23337")
    expect(result.cwe).toBe("CWE-1035")
    expect(result.cvss).toBe(7.2)
    expect(result.remediation_steps).toContain("4.17.21")
    expect(result.remediation_steps).toContain("npm update lodash")
  })

  it("generates a stable dedup ID", () => {
    const r1 = normalizeScaFinding(sampleDep, targetId)
    const r2 = normalizeScaFinding(sampleDep, targetId)
    expect(r1.id).toBe(r2.id)
  })
})

describe("parseScaOutput", () => {
  it("parses valid JSON array", () => {
    const raw = JSON.stringify([sampleDep])
    const result = parseScaOutput(raw)
    expect(result).toHaveLength(1)
    expect(result[0]!.package).toBe("lodash")
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseScaOutput("not json")).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(parseScaOutput("")).toEqual([])
  })

  it("filters out invalid entries", () => {
    const raw = JSON.stringify([
      sampleDep,
      { package: "missing version" },
      "not an object",
    ])
    const result = parseScaOutput(raw)
    expect(result).toHaveLength(1)
  })
})

describe("sortBySeverity", () => {
  it("sorts by severity descending", () => {
    const vulns: DependencyVulnerability[] = [
      { ...sampleDep, severity: "low" },
      { ...sampleDep, severity: "critical" },
      { ...sampleDep, severity: "medium" },
    ]
    const sorted = sortBySeverity(vulns)
    expect(sorted[0]!.severity).toBe("critical")
    expect(sorted[1]!.severity).toBe("medium")
    expect(sorted[2]!.severity).toBe("low")
  })
})

describe("deduplicateScaFindings", () => {
  it("removes duplicates by package + cve + version", () => {
    const vulns: DependencyVulnerability[] = [
      sampleDep,
      { ...sampleDep },
      { ...sampleDep, cve: "CVE-2021-99999" },
    ]
    const result = deduplicateScaFindings(vulns)
    expect(result).toHaveLength(2)
  })
})
