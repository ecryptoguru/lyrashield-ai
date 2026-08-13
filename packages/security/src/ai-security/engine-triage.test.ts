import { describe, expect, it } from "vitest"
import { applyEngineTriageArtifact, parseEngineTriageArtifact } from "./engine-triage"
import type { AISecuritySignal } from "./types"

const checksum = "a".repeat(64)
const baseSignal: AISecuritySignal = {
  controlId: "AI-01",
  ruleId: "AI-01.direct-llm-input",
  owaspMapping: "LLM01:2025",
  state: "DETECTED",
  severity: "HIGH",
  file: "ask.ts",
  line: 12,
  snippet: "openai.chat.completions.create",
  remediation: "Validate and sanitize user input before sending to the LLM.",
  evidenceSource: "deterministic",
  detectorVersion: "ai-app-security/2026-08-13.1",
  evidenceChecksum: checksum,
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "ai-security-triage/1.0",
    status: "COMPLETED",
    terminalReason: null,
    policyVersion: "ai-security-triage-policy/1.0",
    modelRoute: "azure_ai/gpt-5.6-luna",
    inputChecksum: checksum,
    cacheKey: checksum,
    redactionReceipt: {
      policyVersion: "ai-security-triage-policy/1.0",
      inputChecksum: checksum,
      redactedFieldCounts: { "[SECRET]": 1 },
      boundedExcerptBytes: 4096,
    },
    results: [
      {
        findingIdentity: checksum,
        disposition: "LIKELY_FALSE_POSITIVE",
        confidence: 0.73,
        explanation: "The bounded context contradicts this candidate.",
        evidenceChecksum: checksum,
      },
    ],
    ...overrides,
  }
}

describe("parseEngineTriageArtifact", () => {
  it("accepts only the bounded, versioned engine artifact", () => {
    expect(parseEngineTriageArtifact(artifact())).toMatchObject({ status: "COMPLETED" })
    expect(parseEngineTriageArtifact(artifact({ schemaVersion: "wrong" }))).toBeNull()
    expect(
      parseEngineTriageArtifact(
        artifact({ results: [{ ...artifact().results[0], findingIdentity: "b".repeat(64) }] })
      )
    ).toBeNull()
  })
})

describe("applyEngineTriageArtifact", () => {
  it("adds metadata without changing deterministic evidence or state", () => {
    const signals = applyEngineTriageArtifact([baseSignal], parseEngineTriageArtifact(artifact()))

    expect(signals[0]).toMatchObject({
      state: "DETECTED",
      severity: "HIGH",
      evidenceChecksum: checksum,
      triage: {
        disposition: "LIKELY_FALSE_POSITIVE",
        confidence: 73,
        modelRoute: "azure_ai/gpt-5.6-luna",
      },
    })
  })

  it("leaves deterministic signals byte-for-byte unchanged when triage is terminal", () => {
    const result = applyEngineTriageArtifact(
      [baseSignal],
      parseEngineTriageArtifact(artifact({ status: "BUDGET_STOPPED", terminalReason: "CAP" }))
    )

    expect(result[0]).toEqual(baseSignal)
  })
})
