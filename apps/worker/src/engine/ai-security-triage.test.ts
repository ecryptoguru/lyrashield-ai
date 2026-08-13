import { describe, expect, it } from "vitest"
import { buildEngineTriageInput, eligibleForEngineTriage } from "./ai-security-triage"

const signal = {
  controlId: "AI-01",
  ruleId: "AI-01.example",
  owaspMapping: "LLM01:2025",
  state: "DETECTED" as const,
  severity: "MEDIUM" as const,
  snippet: "bounded candidate",
  remediation: "Fix it",
  evidenceSource: "deterministic" as const,
  detectorVersion: "ai-app-security/2026-08-13.1",
  evidenceChecksum: "a".repeat(64),
}

describe("engine AI-security triage selection", () => {
  it("sends only bounded deterministic evidence without a source path", () => {
    const input = buildEngineTriageInput([signal], "b".repeat(40))
    expect(input).toMatchObject({ candidates: [{ findingIdentity: "a".repeat(64) }] })
    expect(JSON.stringify(input)).not.toContain("file")
  })

  it("requires paid eligibility, exact accounting, and remaining scan budget", () => {
    expect(
      eligibleForEngineTriage({
        enabled: true,
        workspacePlan: "PRO",
        mode: "STANDARD",
        billedCostUsd: 1,
        costReconciled: true,
        maxBudgetUsd: 3.2,
        triageCapUsd: 0.2,
      })
    ).toEqual({ eligible: true, reason: "ELIGIBLE", maxBudgetUsd: 0.2 })
    expect(
      eligibleForEngineTriage({
        enabled: true,
        workspacePlan: "FREE",
        mode: "STANDARD",
        billedCostUsd: 1,
        costReconciled: true,
        maxBudgetUsd: 3.2,
        triageCapUsd: 0.2,
      })
    ).toMatchObject({ eligible: false, reason: "PAID_PLAN_REQUIRED" })
  })
})
