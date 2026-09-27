import { describe, it, expect } from "vitest"
import { verifyVulnerability } from "./verifier"
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
  it("keeps engine-provided PoC claims unverified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      poc_script_code: "console.log('exploit')",
      poc_description: "Run the script to exploit",
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("engine_claim_pending_verification")
  })

  it("keeps engine-provided PoC descriptions unverified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      poc_description: "Steps to exploit",
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("engine_claim_pending_verification")
  })

  it("keeps engine-provided code diffs unverified", () => {
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
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("engine_claim_pending_verification")
  })

  it("keeps engine-provided code locations unverified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      code_locations: [{ file: "src/app.ts", start_line: 10 }],
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("engine_claim_pending_verification")
  })

  it("keeps engine-provided analysis unverified", () => {
    const result = verifyVulnerability({
      ...baseVuln,
      technical_analysis: "Detailed analysis",
      impact: "Business impact",
    })
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe("medium")
    expect(result.verificationMethod).toBe("engine_claim_pending_verification")
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
