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
    expect(remote).not.toContain("Authorization")
  })

  it("does not ask Agent Plugin users to configure an MCP server a second time", () => {
    const wizard = buildAgentWizard("openai-codex-agent-plugin", "https://app.lyrashieldai.com")

    expect(wizard?.steps.some((step) => step.id === "config")).toBe(false)
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBeUndefined()
    expect(wizard?.steps.find((step) => step.id === "api-key")?.summary).toContain("OAuth in")
    expect(wizard?.steps.some((step) => step.kind === "rules")).toBe(false)
  })

  it("keeps the standalone CLI workflow for Aider", () => {
    const wizard = buildAgentWizard("aider", "https://app.lyrashieldai.com")
    expect(wizard?.steps.some((step) => step.title.includes("MCP"))).toBe(false)
    expect(wizard?.steps.find((step) => step.id === "verify")?.command).toBe(
      "lyrashield check-diff"
    )
  })

  it("uses Pi's native MCP OAuth setup and exposes its distribution state separately", () => {
    const wizard = buildAgentWizard("pi", "https://app.lyrashieldai.com")
    const config = wizard?.steps.find((step) => step.id === "config")

    expect(wizard?.displayName).toBe("Pi")
    expect(config?.snippet).toContain("https://app.lyrashieldai.com/api/mcp")
    expect(config?.snippet).not.toContain("Authorization")
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBe(
      "pi mcp login lyrashield"
    )
    expect(wizard?.steps.some((step) => step.kind === "rules")).toBe(false)
    expect(wizard?.supportTier).toBe("COMPATIBLE")
    expect(wizard?.verification?.evidence).toBe("DOCUMENTATION")
    expect(wizard?.distribution?.state).toBe("PREPARATION")
  })

  it("keeps Devin Desktop distinct from cloud Devin and Devin CLI", () => {
    const desktop = buildAgentWizard("devin-desktop", "https://app.lyrashieldai.com")
    const cloud = buildAgentWizard("devin", "https://app.lyrashieldai.com")
    const cli = buildAgentWizard("devin-cli", "https://app.lyrashieldai.com")

    expect(desktop?.displayName).toContain("Desktop")
    expect(desktop?.surface).toBe("desktop")
    expect(desktop?.steps.find((step) => step.id === "config")?.snippet).toContain(
      "https://app.lyrashieldai.com/api/mcp"
    )
    expect(desktop?.steps.some((step) => step.id === "config-local")).toBe(false)
    expect(cloud?.surface).toBe("cloud")
    expect(cli?.surface).toBe("cli")
  })

  it("includes manual plugin activation and honest client verification", () => {
    const wizard = buildAgentWizard("kiro-agent-plugin", "https://app.lyrashieldai.com")
    expect(wizard?.steps.find((step) => step.id === "config")?.summary).toContain(".mcp.kiro.json")
    expect(wizard?.steps.find((step) => step.id === "verify")?.note).toContain("read-only")
  })

  it("uses Devin's MCP Marketplace instead of a fictitious local config file", () => {
    const wizard = buildAgentWizard("devin", "https://app.lyrashieldai.com")

    const config = wizard?.steps.find((step) => step.id === "config")
    expect(wizard?.displayName).toBe("Devin")
    expect(config?.title).toBe("Add LyraShield in the agent")
    expect(config?.note).toContain("MCP Marketplace")
    expect(config?.snippet).toContain("https://app.lyrashieldai.com/api/mcp")
    expect(config?.snippet).toContain("Authentication: OAuth")
    expect(config?.snippet).not.toContain("Bearer")
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBeUndefined()
  })

  it("renders native OAuth config for OpenCode and Hermes without bearer placeholders", () => {
    for (const agentId of ["opencode", "hermes"]) {
      const wizard = buildAgentWizard(agentId, "https://app.lyrashieldai.com")
      const remote = wizard?.steps.find((step) => step.id === "config-remote")?.snippet
      expect(remote).toContain("https://app.lyrashieldai.com/api/mcp")
      expect(remote).not.toContain("Authorization")
    }
    expect(
      buildAgentWizard("hermes", "https://app.lyrashieldai.com")?.steps.find(
        (step) => step.id === "config-remote"
      )?.snippet
    ).toContain('auth: "oauth"')
  })

  it("keeps scans explicit and gives safe optional hook guidance", () => {
    const wizard = buildAgentWizard("claude-code", "https://app.lyrashieldai.com")
    const verify = wizard?.steps.find((step) => step.id === "verify")
    const hooks = wizard?.steps.find((step) => step.id === "hooks")

    expect(verify?.summary).toContain("Scans remain explicit")
    expect(verify?.command).toBe("lyrashield doctor")
    expect(hooks?.note).toContain("refuses to overwrite an existing hook")
    expect(hooks?.note).not.toContain("delete .git/hooks/pre-commit")
  })
})
