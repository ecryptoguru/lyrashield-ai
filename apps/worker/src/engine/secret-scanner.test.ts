import { describe, it, expect } from "vitest"
import {
  normalizeSecretFinding,
  parseSecretScanOutput,
  redactSecretValue,
  generateSecretFingerprint,
  deduplicateSecretFindings,
  type SecretFinding,
} from "./secret-scanner"

const targetId = "target-456"

const sampleSecret: SecretFinding = {
  type: "AWS Access Key ID",
  ruleId: "aws-access-key",
  severity: "critical",
  filePath: "src/config.ts",
  startLine: 42,
  matchedText: "AKIA...ABCD",
  redactedValue: "AKIA...ABCD",
  fingerprint: "src/config.ts:42:aws-access-key",
  description: "AWS Access Key ID detected",
}

describe("normalizeSecretFinding", () => {
  it("converts a secret finding to EngineVulnerability format", () => {
    const result = normalizeSecretFinding(sampleSecret, targetId)
    expect(result.title).toContain("AWS Access Key ID")
    expect(result.title).toContain("src/config.ts")
    expect(result.severity).toBe("critical")
    expect(result.cwe).toBe("CWE-798")
    expect(result.poc_description).toContain("src/config.ts:42")
    expect(result.code_locations).toBeDefined()
    expect(result.code_locations![0]!.file).toBe("src/config.ts")
  })

  it("uses default severity when ruleId not in map", () => {
    const result = normalizeSecretFinding(
      { ...sampleSecret, ruleId: "custom-rule", severity: "medium" },
      targetId,
    )
    expect(result.severity).toBe("medium")
  })
})

describe("parseSecretScanOutput", () => {
  it("parses valid JSON array", () => {
    const raw = JSON.stringify([sampleSecret])
    const result = parseSecretScanOutput(raw)
    expect(result).toHaveLength(1)
    expect(result[0]!.ruleId).toBe("aws-access-key")
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseSecretScanOutput("not json")).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(parseSecretScanOutput("")).toEqual([])
  })
})

describe("redactSecretValue", () => {
  it("redacts long values", () => {
    expect(redactSecretValue("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA...MPLE")
  })

  it("fully redacts short values", () => {
    expect(redactSecretValue("short")).toBe("***REDACTED***")
  })
})

describe("generateSecretFingerprint", () => {
  it("generates a stable fingerprint", () => {
    const f1 = generateSecretFingerprint("src/app.ts", 10, "aws-key")
    const f2 = generateSecretFingerprint("src/app.ts", 10, "aws-key")
    expect(f1).toBe(f2)
    expect(f1).toHaveLength(16)
  })

  it("generates different fingerprints for different inputs", () => {
    const f1 = generateSecretFingerprint("src/app.ts", 10, "aws-key")
    const f2 = generateSecretFingerprint("src/app.ts", 11, "aws-key")
    expect(f1).not.toBe(f2)
  })
})

describe("deduplicateSecretFindings", () => {
  it("removes duplicates by fingerprint", () => {
    const findings: SecretFinding[] = [
      sampleSecret,
      { ...sampleSecret },
      { ...sampleSecret, fingerprint: "different" },
    ]
    const result = deduplicateSecretFindings(findings)
    expect(result).toHaveLength(2)
  })
})
