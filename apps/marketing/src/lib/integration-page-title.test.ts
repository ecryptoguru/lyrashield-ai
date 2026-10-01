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
})
