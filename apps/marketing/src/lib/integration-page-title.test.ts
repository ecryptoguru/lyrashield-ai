import { describe, expect, it } from "vitest"
import { listGeneratedIntegrationDocs } from "./integration-doc-routes"
import { buildIntegrationPageTitle } from "./integration-page-title"

describe("generated integration page titles", () => {
  it("keeps every generated registry guide title within the 60-character search limit", () => {
    const generatedAgents = listGeneratedIntegrationDocs()

    expect(generatedAgents.length).toBeGreaterThan(0)
    for (const agent of generatedAgents) {
      expect(buildIntegrationPageTitle(agent.displayName).length).toBeLessThanOrEqual(60)
    }
  })

  it("drops connector qualifiers from SEO titles while preserving the full in-page name", () => {
    expect(buildIntegrationPageTitle("Claude Desktop (OAuth connector)")).toBe(
      "LyraShield setup for Claude Desktop | LyraShield AI"
    )
    expect(buildIntegrationPageTitle("Claude Web (OAuth connector)")).toBe(
      "LyraShield setup for Claude Web | LyraShield AI"
    )
  })

  it("uses concise names for known long client identities instead of mid-word truncation", () => {
    expect(buildIntegrationPageTitle("GitHub Copilot Cloud Agent")).toBe(
      "LyraShield setup for GitHub Copilot Cloud | LyraShield AI"
    )
    expect(buildIntegrationPageTitle("GitHub Copilot in VS Code (Agent Plugin)")).toBe(
      "LyraShield setup for Copilot VS Code Plugin | LyraShield AI"
    )
    expect(buildIntegrationPageTitle("Devin Desktop / Cascade")).toBe(
      "LyraShield setup for Devin Desktop | LyraShield AI"
    )
  })

  it("never truncates a generated guide's client name mid-word", () => {
    // A title ending in "…" means a new registry name outgrew the budget and
    // needs an explicit override in TITLE_NAME_OVERRIDES — silently shipping a
    // cut-off product name is what shipped for Copilot Cloud Agent.
    const truncated = listGeneratedIntegrationDocs()
      .map((agent) => agent.displayName)
      .filter((name) => buildIntegrationPageTitle(name).includes("…"))
    expect(truncated).toEqual([])
  })

  it("keeps generated guide titles unique", () => {
    const titles = listGeneratedIntegrationDocs().map((agent) =>
      buildIntegrationPageTitle(agent.displayName)
    )
    expect(new Set(titles).size).toBe(titles.length)
  })
})
