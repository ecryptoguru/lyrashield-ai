import { describe, it, expect } from "vitest"
import { runOwaspSuite, OWASP_TEST_CASES } from "../src/index.js"
import { PromptInjectionGuard } from "@lyrashield/mcp"

describe("OWASP Gen AI Red Teaming suite", () => {
  it("has test cases across all 4 areas", () => {
    const areas = new Set(OWASP_TEST_CASES.map((tc) => tc.area))
    expect(areas.has("model_evaluation")).toBe(true)
    expect(areas.has("implementation_testing")).toBe(true)
    expect(areas.has("infrastructure_assessment")).toBe(true)
    expect(areas.has("runtime_behavior")).toBe(true)
  })

  it("has at least 36 test cases", () => {
    expect(OWASP_TEST_CASES.length).toBeGreaterThanOrEqual(36)
  })

  it("runs and produces a valid result", () => {
    const result = runOwaspSuite()
    expect(result.suite).toBe("owasp_genai_red_team")
    expect(result.totals.total).toBe(OWASP_TEST_CASES.length)
    expect(result.categories).toHaveLength(4)
    expect(result.totals.blocked + result.totals.sanitized + result.totals.allowed).toBe(
      result.totals.total
    )
    expect(result.totals.expectedOutcomes).toBe(result.cases!.filter((c) => c.expected).length)
    expect(result.totals.expectedOutcomeRate).toBeCloseTo(
      (result.totals.expectedOutcomes! / result.totals.total) * 100
    )
  })

  it("blocks all instruction override attempts in model evaluation", () => {
    const result = runOwaspSuite()
    const meCases = result.cases!.filter((c) => c.id.startsWith("owasp-me-"))
    const blockedOrSanitized = meCases.filter(
      (c) => c.outcome === "blocked" || c.outcome === "sanitized"
    )
    // All adversarial ME cases (01–09) should be blocked; benign (10–12) should be allowed
    const adversarial = meCases.filter(
      (c) => !c.id.includes("10") && !c.id.includes("11") && !c.id.includes("12")
    )
    const allBlocked = adversarial.every((c) => c.outcome === "blocked")
    expect(allBlocked).toBe(true)
  })

  it("blocks bypass attempts in implementation testing (2 known limitations remain)", () => {
    const result = runOwaspSuite()
    const itCases = result.cases!.filter((c) => c.id.startsWith("owasp-it-"))
    const blocked = itCases.filter((c) => c.outcome === "blocked")
    // 14 of 16 IT cases should be blocked; 2 known limitations (dot-separation, non-English)
    expect(blocked.length).toBeGreaterThanOrEqual(14)
    // The 2 known limitations should be documented as "allowed" (not silently failing)
    const knownLimitations = itCases.filter((c) => c.outcome === "allowed")
    expect(knownLimitations.length).toBe(2)
  })

  it("blocks prompt injection in infrastructure assessment tool args", () => {
    const result = runOwaspSuite()
    const iaAdversarial = result.cases!.filter(
      (c) =>
        c.id.startsWith("owasp-ia-") &&
        c.id !== "owasp-ia-01" &&
        c.id !== "owasp-ia-02" &&
        c.id !== "owasp-ia-06"
    )
    const allBlocked = iaAdversarial.every((c) => c.outcome === "blocked")
    expect(allBlocked).toBe(true)
  })

  it("blocks indirect prompt injection in runtime behavior", () => {
    const result = runOwaspSuite()
    const rbAdversarial = result.cases!.filter(
      (c) => c.id.startsWith("owasp-rb-") && c.id !== "owasp-rb-06" && c.id !== "owasp-rb-07"
    )
    const allBlocked = rbAdversarial.every((c) => c.outcome === "blocked")
    expect(allBlocked).toBe(true)
  })

  it("allows benign inputs through", () => {
    const result = runOwaspSuite()
    const benignIds = [
      "owasp-me-10",
      "owasp-me-11",
      "owasp-me-12",
      "owasp-ia-06",
      "owasp-rb-06",
      "owasp-rb-07",
    ]
    const benignCases = result.cases!.filter((c) => benignIds.includes(c.id))
    const allAllowed = benignCases.every((c) => c.outcome === "allowed")
    expect(allAllowed).toBe(true)
  })

  it("produces reproducible results", () => {
    const guard = new PromptInjectionGuard()
    const r1 = runOwaspSuite(guard)
    const r2 = runOwaspSuite(guard)
    expect(r1.totals).toEqual(r2.totals)
  })
})
