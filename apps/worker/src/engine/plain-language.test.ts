import { describe, it, expect } from "vitest"
import { explainFinding } from "./plain-language"

describe("explainFinding", () => {
  it("returns CWE-specific explanation for CWE-79", () => {
    const result = explainFinding({
      title: "XSS in search field",
      severity: "HIGH",
      cwe: "CWE-79",
    })
    expect(result.title).toBe("Cross-Site Scripting (XSS)")
    expect(result.whatItIs).toContain("sanitization")
    expect(result.howToFix).toContain("Escape")
    expect(result.difficulty).toBe("easy")
  })

  it("returns CWE-specific explanation for CWE-89", () => {
    const result = explainFinding({
      title: "SQL Injection in login",
      severity: "CRITICAL",
      cwe: "CWE-89",
    })
    expect(result.title).toBe("SQL Injection")
    expect(result.howToFix).toContain("parameterized")
  })

  it("uses recommendedFix when provided", () => {
    const result = explainFinding({
      title: "Custom vuln",
      severity: "HIGH",
      cwe: "CWE-79",
      recommendedFix: "Use DOMPurify specifically",
    })
    expect(result.howToFix).toBe("Use DOMPurify specifically")
  })

  it("falls back to severity-based generic explanation", () => {
    const result = explainFinding({
      title: "Unknown vulnerability",
      severity: "CRITICAL",
    })
    expect(result.title).toBe("Unknown vulnerability")
    expect(result.whatItIs).toContain("critical vulnerability")
    expect(result.difficulty).toBe("hard")
  })

  it("falls back to low severity generic", () => {
    const result = explainFinding({
      title: "Minor issue",
      severity: "LOW",
    })
    expect(result.difficulty).toBe("easy")
    expect(result.estimatedTimeToFix).toBe("30 min")
  })

  it("falls back to info severity generic", () => {
    const result = explainFinding({
      title: "Info note",
      severity: "INFO",
    })
    expect(result.whatItIs).toContain("not a vulnerability")
  })
})
