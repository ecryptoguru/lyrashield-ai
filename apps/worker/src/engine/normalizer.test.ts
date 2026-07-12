import { describe, it, expect } from "vitest"
import type { EngineVulnerability } from "./output-parser"
import {
  normalizeFindings,
  normalizeSeverity,
  normalizeCwe,
  assessFalsePositiveRisk,
  enrichCwe,
  calculateCvssFromSeverity,
  calculateConfidenceScore,
  calculateRemediationPriority,
  filterFalsePositives,
  getFindingStats,
} from "./normalizer"
import { generateDedupeKey } from "./output-parser"

const baseVuln: EngineVulnerability = {
  id: "v1",
  title: "SQL Injection in login form",
  severity: "high",
  timestamp: new Date().toISOString(),
  target: "https://app.test-target.com",
  endpoint: "/login",
  method: "POST",
  cwe: "CWE-89",
  description: "SQL injection vulnerability in the login endpoint",
}

function makeVuln(overrides: Partial<EngineVulnerability> = {}): EngineVulnerability {
  return { ...baseVuln, ...overrides }
}

describe("normalizeSeverity", () => {
  it("maps standard severity levels", () => {
    expect(normalizeSeverity("critical")).toBe("CRITICAL")
    expect(normalizeSeverity("high")).toBe("HIGH")
    expect(normalizeSeverity("medium")).toBe("MEDIUM")
    expect(normalizeSeverity("moderate")).toBe("MEDIUM")
    expect(normalizeSeverity("low")).toBe("LOW")
    expect(normalizeSeverity("info")).toBe("INFO")
    expect(normalizeSeverity("informational")).toBe("INFO")
  })

  it("defaults to INFO for unknown severity", () => {
    expect(normalizeSeverity("unknown")).toBe("INFO")
  })
})

describe("normalizeCwe", () => {
  it("normalizes CWE identifiers", () => {
    expect(normalizeCwe("CWE-79")).toBe("CWE-79")
    expect(normalizeCwe("cwe-89")).toBe("CWE-89")
    expect(normalizeCwe("79")).toBe("CWE-79")
    expect(normalizeCwe(undefined)).toBeNull()
    expect(normalizeCwe("")).toBeNull()
  })
})

describe("assessFalsePositiveRisk", () => {
  it("returns high risk for test environment references in target/endpoint", () => {
    expect(assessFalsePositiveRisk(makeVuln({ target: "http://localhost:3000" }))).toBe("high")
    expect(assessFalsePositiveRisk(makeVuln({ endpoint: "example.com/api" }))).toBe("high")
    expect(assessFalsePositiveRisk(makeVuln({ target: "test server" }))).toBe("high")
  })

  it("does not flag findings that mention test domains in title only", () => {
    expect(assessFalsePositiveRisk(makeVuln({ title: "XSS on test server" }))).not.toBe("high")
  })

  it("returns medium risk for findings without PoC evidence on real targets", () => {
    expect(assessFalsePositiveRisk(makeVuln({ poc_description: undefined }))).toBe("medium")
  })

  it("returns low risk for findings with PoC evidence on real targets", () => {
    expect(assessFalsePositiveRisk(makeVuln({ poc_description: "Steps to exploit" }))).toBe("low")
  })
})

describe("enrichCwe", () => {
  it("enriches known CWEs with metadata", () => {
    const enriched = enrichCwe("CWE-89")
    expect(enriched.cweName).toBe("SQL Injection")
    expect(enriched.cweCategory).toBe("Injection")
    expect(enriched.owaspCategory).toBe("A03:2021-Injection")
  })

  it("returns empty object for unknown CWEs", () => {
    expect(enrichCwe("CWE-999")).toEqual({})
    expect(enrichCwe(undefined)).toEqual({})
  })
})

describe("calculateCvssFromSeverity", () => {
  it("maps severity to CVSS score", () => {
    expect(calculateCvssFromSeverity("critical")).toBe(9.5)
    expect(calculateCvssFromSeverity("high")).toBe(7.5)
    expect(calculateCvssFromSeverity("medium")).toBe(5.0)
    expect(calculateCvssFromSeverity("low")).toBe(2.5)
    expect(calculateCvssFromSeverity("info")).toBe(0.0)
  })
})

describe("calculateConfidenceScore", () => {
  it("returns 95 for PoC script + description", () => {
    expect(
      calculateConfidenceScore(
        makeVuln({
          poc_script_code: "curl http://example.com",
          poc_description: "Run the curl command",
        })
      )
    ).toBe(95)
  })

  it("returns 85 for PoC description only", () => {
    expect(
      calculateConfidenceScore(
        makeVuln({
          poc_description: "Steps to exploit",
        })
      )
    ).toBe(85)
  })

  it("returns 90 for code location with fix diff", () => {
    expect(
      calculateConfidenceScore(
        makeVuln({
          code_locations: [
            { file: "src/app.ts", start_line: 10, fix_before: "bad", fix_after: "good" },
          ],
        })
      )
    ).toBe(90)
  })

  it("returns 40 for CVE/CWE only", () => {
    expect(calculateConfidenceScore(makeVuln({ cve: "CVE-2024-1234" }))).toBe(40)
  })

  it("returns 20 for no evidence", () => {
    expect(calculateConfidenceScore(makeVuln({ cwe: undefined }))).toBe(20)
  })
})

describe("calculateRemediationPriority", () => {
  it("prioritizes high severity + high confidence", () => {
    expect(calculateRemediationPriority("CRITICAL", 95, "low")).toBe(5)
    expect(calculateRemediationPriority("HIGH", 85, "low")).toBe(4)
    expect(calculateRemediationPriority("LOW", 20, "high")).toBe(0)
  })
})

describe("normalizeFindings", () => {
  it("normalizes and deduplicates findings", () => {
    const vulns = [
      makeVuln({ id: "v1", title: "XSS", severity: "high", cwe: "CWE-79" }),
      makeVuln({ id: "v2", title: "XSS", severity: "high", cwe: "CWE-79" }),
      makeVuln({ id: "v3", title: "SQLi", severity: "critical", cwe: "CWE-89" }),
    ]

    const result = normalizeFindings(vulns, "target-1", generateDedupeKey)

    expect(result.length).toBe(2)
    expect(result[0]!.normalizedSeverity).toBe("CRITICAL")
    expect(result[1]!.normalizedSeverity).toBe("HIGH")
  })

  it("keeps higher severity on dedupe conflict", () => {
    const vulns = [
      makeVuln({ id: "v1", title: "XSS", severity: "low", cwe: "CWE-79", endpoint: "/page" }),
      makeVuln({ id: "v2", title: "XSS", severity: "high", cwe: "CWE-79", endpoint: "/page" }),
    ]

    const result = normalizeFindings(vulns, "target-1", generateDedupeKey)
    expect(result.length).toBe(1)
    expect(result[0]!.normalizedSeverity).toBe("HIGH")
  })

  it("enriches findings with CWE metadata", () => {
    const result = normalizeFindings([makeVuln({ cwe: "CWE-89" })], "target-1", generateDedupeKey)
    expect(result[0]!.enrichment.cweName).toBe("SQL Injection")
    expect(result[0]!.enrichment.cweCategory).toBe("Injection")
  })

  it("handles empty input", () => {
    expect(normalizeFindings([], "target-1", generateDedupeKey)).toEqual([])
  })
})

describe("filterFalsePositives", () => {
  it("filters out high false-positive risk findings", () => {
    const vulns = [
      makeVuln({
        id: "v1",
        title: "XSS",
        target: "http://localhost:3000",
        endpoint: "/search",
        cwe: "CWE-79",
      }),
      makeVuln({
        id: "v2",
        title: "SQLi in production",
        poc_description: "Steps",
        endpoint: "/login",
        cwe: "CWE-89",
      }),
    ]
    const normalized = normalizeFindings(vulns, "target-1", generateDedupeKey)
    const filtered = filterFalsePositives(normalized)
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.title).toBe("SQLi in production")
  })
})

describe("getFindingStats", () => {
  it("calculates stats correctly", () => {
    const vulns = [
      makeVuln({
        id: "v1",
        severity: "critical",
        poc_description: "PoC",
        endpoint: "/admin",
        cwe: "CWE-89",
      }),
      makeVuln({ id: "v2", severity: "high", cwe: "CWE-79", endpoint: "/search" }),
      makeVuln({ id: "v3", severity: "low", endpoint: "/page" }),
    ]
    const normalized = normalizeFindings(vulns, "target-1", generateDedupeKey)
    const stats = getFindingStats(normalized)

    expect(stats.total).toBe(3)
    expect(stats.bySeverity["CRITICAL"]).toBe(1)
    expect(stats.bySeverity["HIGH"]).toBe(1)
    expect(stats.bySeverity["LOW"]).toBe(1)
    expect(stats.verified).toBeGreaterThanOrEqual(1)
  })
})

describe("golden-file: full normalization pipeline", () => {
  it("normalizes, filters, and stats a realistic set of engine findings", () => {
    const input: EngineVulnerability[] = [
      // Critical with PoC — should survive filtering, high confidence
      {
        id: "v1",
        title: "SQL Injection in login",
        severity: "critical",
        timestamp: "now",
        cwe: "CWE-89",
        endpoint: "/login",
        poc_description: "Inject ' OR 1=1 --",
        description: "SQLi via login form",
      },
      // High without PoC — should survive, medium confidence
      {
        id: "v2",
        title: "XSS in search",
        severity: "high",
        timestamp: "now",
        cwe: "CWE-79",
        endpoint: "/search",
        description: "Reflected XSS",
      },
      // Duplicate of v1 (same dedupe key) with lower severity — should be deduped
      {
        id: "v3",
        title: "SQL Injection in login",
        severity: "medium",
        timestamp: "now",
        cwe: "CWE-89",
        endpoint: "/login",
        description: "SQLi via login form",
      },
      // False positive — localhost target
      {
        id: "v4",
        title: "Open redirect",
        severity: "medium",
        timestamp: "now",
        target: "http://localhost:3000",
        cwe: "CWE-601",
        endpoint: "/redirect",
      },
      // Info severity
      {
        id: "v5",
        title: "Missing HSTS header",
        severity: "info",
        timestamp: "now",
        cwe: "CWE-319",
        endpoint: "/",
      },
    ]

    const normalized = normalizeFindings(input, "target-1", generateDedupeKey)
    const filtered = filterFalsePositives(normalized)
    const stats = getFindingStats(filtered)

    // v3 should be deduped (same dedupe key as v1, lower severity)
    expect(normalized.length).toBe(4)
    // v4 should be filtered as false positive (localhost target)
    expect(filtered.length).toBe(3)
    // Stats should reflect filtered set
    expect(stats.total).toBe(3)
    expect(stats.bySeverity["CRITICAL"]).toBe(1)
    expect(stats.bySeverity["HIGH"]).toBe(1)
    expect(stats.bySeverity["INFO"]).toBe(1)
    // Critical finding should have high confidence (has PoC)
    const critical = filtered.find((f) => f.normalizedSeverity === "CRITICAL")
    expect(critical).toBeDefined()
    expect(critical!.confidenceScore).toBeGreaterThanOrEqual(80)
    // CWE enrichment should be present
    expect(critical!.enrichment.cweName).toBe("SQL Injection")
    expect(critical!.enrichment.owaspCategory).toBe("A03:2021-Injection")
  })
})
