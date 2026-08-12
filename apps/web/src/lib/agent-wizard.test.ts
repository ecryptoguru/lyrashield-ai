import { describe, expect, it } from "vitest"
import { buildAgentWizard } from "./agent-wizard"

describe("agent wizard connection snippets", () => {
  it("uses the API base for local stdio and the MCP endpoint for remote clients", () => {
    const wizard = buildAgentWizard("claude-code", "https://app.lyrashieldai.com")

    const local = wizard?.steps.find((step) => step.id === "config")?.snippet
    const remote = wizard?.steps.find((step) => step.id === "config-remote")?.snippet

    expect(local).toContain('LYRASHIELD_API_URL": "https://app.lyrashieldai.com"')
    expect(local).not.toContain("/api/mcp")
    expect(local).not.toContain("LYRASHIELD_API_KEY")
    expect(remote).toContain("https://app.lyrashieldai.com/api/mcp")
  })

  it("does not ask Agent Plugin users to configure an MCP server a second time", () => {
    const wizard = buildAgentWizard("openai-codex-agent-plugin", "https://app.lyrashieldai.com")

    expect(wizard?.steps.some((step) => step.id === "config")).toBe(false)
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBe(
      "lyrashield login --oauth"
    )
  })

  it("uses Devin's MCP Marketplace instead of a fictitious local config file", () => {
    const wizard = buildAgentWizard("devin", "https://app.lyrashieldai.com")

    const config = wizard?.steps.find((step) => step.id === "config")
    expect(wizard?.displayName).toBe("Devin")
    expect(config?.title).toBe("Add LyraShield in the agent")
    expect(config?.note).toContain("MCP Marketplace")
    expect(config?.snippet).toContain("https://app.lyrashieldai.com/api/mcp")
  })
})
