import { describe, expect, it } from "vitest"
import { explainFinding } from "./plain-language"

describe("explainFinding", () => {
  it.each(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)(
    "keeps %s impact conditional on evidence and context",
    (severity) => {
      const explanation = explainFinding({ title: "Unknown candidate", severity })
      const copy = `${explanation.title} ${explanation.whatItIs} ${explanation.whyItMatters} ${explanation.howToFix}`

      expect(copy).toMatch(/if the reported condition applies|severity alone does not establish/i)
      expect(copy).not.toMatch(
        /typically exploitable|often exploitable|must be fixed before|unlikely to be directly exploitable/i
      )
    }
  )

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
