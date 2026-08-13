import { describe, expect, it } from "vitest"
import { AI_SECURITY_CONTROLS, AI_SECURITY_CONTROLS_BY_ID } from "./controls"
import { AI_SECURITY_FIXTURES, getFixturesByControl } from "./fixtures"
import { AI_RULES } from "./rules"
import type { AIControlId } from "./types"

const EXPECTED_STATES = ["vulnerable", "safe", "unsupported", "truncated"] as const
const FIXTURE_CATEGORIES = ["DETECTED", "NO_FINDING", "INCONCLUSIVE", "INCONCLUSIVE"] as const

describe("AI App Security contract and fixtures", () => {
  it("has 8 controls with stable IDs and OWASP LLM Top 10 2025 mappings", () => {
    expect(AI_SECURITY_CONTROLS).toHaveLength(8)

    const expectedIds: AIControlId[] = [
      "AI-01",
      "AI-02",
      "AI-03",
      "AI-04",
      "AI-05",
      "AI-06",
      "AI-07",
      "AI-08",
    ]

    const actualIds = AI_SECURITY_CONTROLS.map((control) => control.id)
    expect(actualIds).toEqual(expectedIds)

    const expectedOwasp = [
      "LLM01:2025",
      "LLM02:2025",
      "LLM03:2025",
      "LLM05:2025",
      "LLM06:2025",
      "LLM07:2025",
      "LLM08:2025",
      "LLM10:2025",
    ]

    const actualOwasp = AI_SECURITY_CONTROLS.map((control) => control.owaspMapping)
    expect(actualOwasp).toEqual(expectedOwasp)

    for (const control of AI_SECURITY_CONTROLS) {
      expect(AI_SECURITY_CONTROLS_BY_ID[control.id]).toBe(control)
    }
  })

  it("has 8 rule stubs mapped one-to-one to controls", () => {
    expect(AI_RULES).toHaveLength(8)

    const ruleIds = AI_RULES.map((rule) => rule.id)
    expect(new Set(ruleIds).size).toBe(8)

    for (const rule of AI_RULES) {
      const control = AI_SECURITY_CONTROLS_BY_ID[rule.controlId]
      expect(control).toBeDefined()
    }
  })

  it("has vulnerable, safe, unsupported, and truncated fixtures for every control", () => {
    for (const control of AI_SECURITY_CONTROLS) {
      const fixtures = getFixturesByControl(control.id)
      expect(fixtures).toHaveLength(4)

      const states = fixtures.map((fixture) => fixture.expectedState)
      expect(states).toEqual([...FIXTURE_CATEGORIES])

      for (const [index, category] of EXPECTED_STATES.entries()) {
        const fixture = fixtures[index]
        expect(fixture).toBeDefined()
        if (!fixture) continue

        expect(fixture.file).toBeDefined()
        expect(fixture.file.size).toBeGreaterThan(0)
        expect(fixture.ruleId.startsWith(`${control.id}.`)).toBe(true)

        if (category === "unsupported") {
          expect(fixture.file.language).toBe("unknown")
        }

        if (category === "truncated") {
          expect(fixture.file.truncated).toBe(true)
        }
      }
    }
  })

  it("unsupported and truncated fixtures cannot become NO_FINDING", () => {
    const restricted = AI_SECURITY_FIXTURES.filter(
      (fixture) => fixture.file.language === "unknown" || fixture.file.truncated === true
    )

    expect(restricted.length).toBeGreaterThan(0)

    for (const fixture of restricted) {
      expect(
        fixture.expectedState,
        `Fixture ${fixture.name} expected ${fixture.expectedState}, but unsupported/truncated inputs cannot be NO_FINDING`
      ).not.toBe("NO_FINDING")
    }
  })
})
