import { describe, expect, it } from "vitest"
import { explainFinding } from "./plain-language"

describe("explainFinding", () => {
  it("keeps technical evidence out of the plain-language summary", () => {
    const explanation = explainFinding({
      title: "Vulnerable dependency",
      severity: "CRITICAL",
      cwe: "CWE-1104",
      recommendedFix: "Upgrade the dependency and retest.",
    })

    expect(explanation.whatItIs).not.toContain("Technical detail:")
    expect(explanation.howToFix).toBe("Upgrade the dependency and retest.")
  })

  it("uses a category-specific title for generic explanations", () => {
    const explanation = explainFinding({
      title: "Unsafe input",
      severity: "HIGH",
      category: "injection",
    })

    expect(explanation.title).toBe("Injection Vulnerability")
  })
})
