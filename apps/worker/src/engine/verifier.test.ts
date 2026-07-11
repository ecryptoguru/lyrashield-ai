import { describe, it, expect } from "vitest"
import { verifyVulnerability, verifyFindings, getConfidenceScore } from "./verifier"
import type { EngineVulnerability } from "./output-parser"

const baseVuln: EngineVulnerability = {
  id: "test-1",
  title: "Test vulnerability",
  severity: "high",
  timestamp: new Date().toISOString(),
  target: "test-target",
  description: "A test vulnerability",
}

describe("verifyVulnerability", () => {
  it("returns high confidence with PoC script + description", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      poc_script_code: "console.log('exploit')",
      poc_description: "Run the script to exploit",
    })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe("high")
    expect(result.verificationMethod).toBe("poc_reproduction")
  })

  it("returns high confidence with PoC description only", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      poc_description: "Steps to exploit",
    })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe("high")
    expect(result.verificationMethod).toBe("poc_description")
  })

  it("returns high confidence with code location + fix diff", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      code_locations: [
        {
          file: "src/app.ts",
          start_line: 10,
          fix_before: "bad code",
          fix_after: "good code",
        },
      ],
    })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe("high")
    expect(result.verificationMethod).toBe("code_diff_analysis")
  })

  it("returns medium confidence with code location only", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      code_locations: [{ file: "src/app.ts", start_line: 10 }],
    })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("static_analysis")
  })

  it("returns medium confidence with technical analysis + impact", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      technical_analysis: "Detailed analysis",
      impact: "Business impact",
    })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("analysis_review")
  })

  it("returns medium confidence with CVE/CWE but not verified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      cve: "CVE-2024-1234",
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("cve_cwe_mapping")
  })

  it("returns medium confidence with CWE only but not verified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      cwe: "CWE-79",
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("cve_cwe_mapping")
  })

  it("returns unverified with no evidence", () => {
    const result = verifyVulnerability(baseVuln)
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("low")
    expect(result.verificationMethod).toBe("unverified")
  })
})

describe("verifyFindings", () => {
  it("verifies a batch of vulnerabilities", () => {
    const vulns = [
      { ...baseVuln, id: "1", poc_description: "PoC" },
      { ...baseVuln, id: "2", cwe: "CWE-79" },
      { ...baseVuln, id: "3" },
    ]
    const results = verifyFindings(vulns)
    expect(results).toHaveLength(3)
    expect(results[0]!.verification.verified).toBe(true)
    expect(results[1]!.verification.verified).toBe(false)
    expect(results[2]!.verification.verified).toBe(false)
  })
})

describe("getConfidenceScore", () => {
  it("returns 0 for unverified", () => {
    expect(
      getConfidenceScore({ verified: false, confidence: "low", reason: "", verificationMethod: "" })
    ).toBe(0)
  })

  it("returns 90 for high confidence", () => {
    expect(
      getConfidenceScore({ verified: true, confidence: "high", reason: "", verificationMethod: "" })
    ).toBe(90)
  })

  it("returns 60 for medium confidence", () => {
    expect(
      getConfidenceScore({
        verified: true,
        confidence: "medium",
        reason: "",
        verificationMethod: "",
      })
    ).toBe(60)
  })

  it("returns 30 for low confidence", () => {
    expect(
      getConfidenceScore({ verified: true, confidence: "low", reason: "", verificationMethod: "" })
    ).toBe(30)
  })
})
