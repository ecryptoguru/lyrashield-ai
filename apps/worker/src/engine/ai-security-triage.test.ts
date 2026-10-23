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
    expect(input).toMatchObject({
      candidates: [{ findingIdentity: "a".repeat(64), selectionReason: "MEDIUM_SEVERITY" }],
    })
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

it("adds bounded path-free PHP context only to candidates within detected PHP scopes", () => {
  const context = {
    scopes: [{ directory: "services/php", hasExactRuntimeIdentity: false }],
    incomplete: true,
  }
  const phpSignal = { ...signal, file: "services/php/agent.php", snippet: "é".repeat(6000) }
  const input = buildEngineTriageInput([phpSignal], "b".repeat(40), context)
  const excerpt = input!.candidates[0]!.evidenceExcerpt
  expect(excerpt).toContain("PHP scope 1")
  expect(excerpt).toContain("incomplete")
  expect(excerpt).toContain("runtime identity unavailable")
  expect(excerpt).toContain("CVE-2026-115560")
  expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(4096)
  expect(excerpt).not.toContain("services/php")
  expect(
    buildEngineTriageInput([{ ...signal, file: "services/js/agent.ts" }], "b".repeat(40), context)
      ?.candidates[0]?.evidenceExcerpt
  ).toBe("bounded candidate")
  expect(
    buildEngineTriageInput([phpSignal], "b".repeat(40))?.candidates[0]?.evidenceExcerpt
  ).not.toContain("PHP scope")
})

it("selects the closest detected service and excludes example evidence from PHP triage context", () => {
  const context = {
    scopes: [
      { directory: ".", hasExactRuntimeIdentity: true },
      { directory: "services/php", hasExactRuntimeIdentity: false },
    ],
    incomplete: true,
  }
  const input = buildEngineTriageInput(
    [{ ...signal, file: "services/php/agent.php" }],
    "b".repeat(40),
    context
  )
  expect(input?.candidates[0]?.evidenceExcerpt).toContain("runtime identity unavailable")
  expect(
    buildEngineTriageInput([{ ...signal, file: "docs/agent.php" }], "b".repeat(40), context)
      ?.candidates[0]?.evidenceExcerpt
  ).toBe("bounded candidate")
})
