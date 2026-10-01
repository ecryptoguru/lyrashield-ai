import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CLI_PACKAGE_VERSION } from "@lyrashield/agent-registry"
import { AgentsGrid, type AgentCardData } from "./agents-grid"

function surface(
  overrides: Partial<AgentCardData> & Pick<AgentCardData, "id" | "displayName">
): AgentCardData {
  return {
    docsSlug: overrides.id,
    installStrategy: "config-file",
    locations: [],
    rulesFiles: [],
    installCommand: `npx -y lyrashield@${CLI_PACKAGE_VERSION} install ${overrides.id}`,
    ...overrides,
  }
}

function render(agents: AgentCardData[]) {
  return renderToStaticMarkup(
    <AgentsGrid
      agents={agents}
      docsBaseUrl="https://lyrashieldai.com/docs/integrations"
      publishedCliVersion={CLI_PACKAGE_VERSION}
    />
  )
}

describe("coding agent product cards", () => {
  it("groups surfaces by product family and keeps setup components distinct", () => {
    const markup = render([
      surface({
        id: "jetbrains",
        displayName: "JetBrains AI Assistant",
        productFamily: { id: "jetbrains", name: "JetBrains" },
        surface: "ide",
        locations: [
          { scope: "global", path: "~/.config/JetBrains/mcp.json", sharedByConvention: false },
        ],
        skillLocations: [{ scope: "project", path: ".agents/skills", sharedByConvention: true }],
        rulesFiles: ["AGENTS.md"],
      }),
      surface({
        id: "junie-cli",
        displayName: "Junie CLI",
        productFamily: { id: "jetbrains", name: "JetBrains" },
        surface: "cli",
        locations: [{ scope: "project", path: ".junie/mcp/mcp.json", sharedByConvention: true }],
      }),
      surface({
        id: "claude-code-agent-plugin",
        displayName: "Claude Code (Agent Plugin)",
        productFamily: { id: "claude", name: "Claude" },
        installStrategy: "agent-plugin",
        pluginLocations: [
          { scope: "global", path: "~/.claude/plugins/lyrashield", sharedByConvention: false },
        ],
        rulesFiles: ["CLAUDE.md"],
      }),
    ])

    expect(markup.match(/aria-labelledby="agent-family-jetbrains"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Choose JetBrains client surface"')
    expect(markup).toContain(".agents/skills")
    expect(markup).toContain("AGENTS.md")
    expect(markup).toContain("Workflow skills ship with the Agent Plugin")
    expect(markup).not.toContain("CLAUDE.md")
    expect(markup).not.toContain("Rules / skills")
    expect(markup).not.toContain('aria-label="Choose Claude client surface"')
  })

  it("shows a setup fallback when a surface has no published install command", () => {
    const markup = render([
      surface({
        id: "junie-cli",
        displayName: "Junie CLI",
        installCommand: null,
        manualInstructions: "Use the client MCP setup flow.",
      }),
    ])

    expect(markup).toContain("No installer for this surface in the published LyraShield CLI 0.2.13")
    expect(markup).toContain("MCP config setup")
    expect(markup).not.toContain("Auto-installs")
    expect(markup).toContain("Use the client MCP setup flow.")
    expect(markup).toContain('href="/dashboard/agents/junie-cli"')
    expect(markup).toContain('href="https://lyrashieldai.com/docs/integrations/junie-cli"')
    expect(markup).not.toContain("npx -y lyrashield@0.2.13 install junie-cli")
  })

  it("retains the empty registry state", () => {
    expect(render([])).toContain("No agents registered.")
  })
})
