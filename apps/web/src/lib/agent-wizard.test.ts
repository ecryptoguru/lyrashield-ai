import { describe, expect, it } from "vitest"
import { CLI_PACKAGE_SPEC, MCP_PACKAGE_SPEC, getAgent } from "@lyrashield/agent-registry"
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

  it.each([
    ["openai-codex-agent-plugin", "~/.codex/config.toml"],
    ["cursor-agent-plugin", "~/.cursor/mcp.json"],
    ["github-copilot-agent-plugin", "~/.copilot/mcp-config.json"],
  ])("keeps %s pending and points to the current direct MCP fallback", (id, configPath) => {
    const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
    expect(wizard?.steps.find((step) => step.id === "install")?.command).toBeUndefined()
    const activation = wizard?.steps.find((step) => step.id === "config")
    expect(activation?.summary).toContain("reviewed matching immutable package release")
    expect(activation?.summary).toContain(configPath)
    expect(activation?.summary).toContain(MCP_PACKAGE_SPEC)
    expect(activation?.summary).toContain(CLI_PACKAGE_SPEC)
    expect(activation?.summary).not.toContain("marketplace add")
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBe(
      `npx -y ${CLI_PACKAGE_SPEC} login --oauth`
    )
    expect(wizard?.steps.find((step) => step.id === "config-mcp-fallback")?.snippetPath).toBe(
      configPath
    )
    expect(wizard?.steps.some((step) => step.kind === "rules")).toBe(false)
  })

  it("keeps Claude's plugin path gated and points to current MCP guidance", () => {
    const wizard = buildAgentWizard("claude-code-agent-plugin", "https://app.lyrashieldai.com")
    expect(wizard?.steps.find((step) => step.id === "install")?.command).toBeUndefined()
    const activation = wizard?.steps.find((step) => step.id === "config")
    expect(activation?.summary).toContain("reviewed matching immutable package release")
    expect(activation?.summary).toContain(".mcp.json")
    expect(activation?.summary).not.toContain("claude plugin marketplace add")
  })

  it("keeps VS Code plugin setup manual and offers the independent MCP fallback", () => {
    const wizard = buildAgentWizard("vscode-agent-plugin", "https://app.lyrashieldai.com")
    const install = wizard?.steps.find((step) => step.id === "install")
    expect(install?.title).toBe("Manual Agent Plugin setup")
    expect(install?.summary).toContain("MANUAL_REQUIRED")
    expect(install?.command).toBeUndefined()
    const fallback = wizard?.steps.find((step) => step.id === "config-mcp-fallback")
    expect(fallback?.optional).toBeUndefined()
    expect(fallback?.snippetPath).toBe(".vscode/mcp.json")
    expect(JSON.parse(fallback?.snippet ?? "null")).toEqual({
      servers: {
        lyrashield: {
          type: "stdio",
          command: "npx",
          args: ["-y", MCP_PACKAGE_SPEC],
          env: { LYRASHIELD_API_URL: "https://app.lyrashieldai.com" },
        },
      },
    })
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBe(
      `npx -y ${CLI_PACKAGE_SPEC} login --oauth`
    )
    expect(wizard?.steps.find((step) => step.id === "api-key")?.summary).toContain("CLI OAuth")
    expect(wizard?.steps.find((step) => step.id === "verify")?.note).toContain("read-only")
  })

  it("uses Pi's native MCP instructions without stale CLI release claims", () => {
    const install = buildAgentWizard("pi", "https://app.lyrashieldai.com")?.steps.find(
      (step) => step.id === "install"
    )
    expect(install?.command).toBeUndefined()
    expect(install?.summary).toContain("built-in MCP client")
    expect(install?.summary).toContain("https://app.lyrashieldai.com/api/mcp")
    expect(install?.summary).toContain(CLI_PACKAGE_SPEC)
    expect(install?.summary).not.toContain("published CLI")
    expect(install?.summary).not.toContain("pending release")
  })

  it("keeps the standalone CLI workflow for Aider", () => {
    const wizard = buildAgentWizard("aider", "https://app.lyrashieldai.com")
    expect(wizard?.steps.some((step) => step.title.includes("MCP"))).toBe(false)
    expect(wizard?.steps.find((step) => step.id === "verify")?.command).toBe(
      `npx -y ${CLI_PACKAGE_SPEC} check-diff`
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

  it("keeps Augment marketplace status separate from candidate MCP and skill setup", () => {
    for (const id of ["augment-vscode", "augment-jetbrains"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      const install = wizard?.steps.find((step) => step.id === "install")
      const config = wizard?.steps.find((step) => step.id === "config")
      const auth = wizard?.steps.find((step) => step.id === "api-key")
      const skills = wizard?.steps.find((step) => step.id === "skills")
      const verify = wizard?.steps.find((step) => step.id === "verify")

      expect(wizard?.distribution?.state, id).toBe("PREPARATION")
      expect(install?.title, id).toBe("Connect current MCP tools")
      expect(install?.summary, id).toContain("native marketplace plugin remains under preparation")
      expect(install?.summary, id).not.toContain("published")
      expect(install?.command, id).toBeUndefined()
      expect(config?.summary, id).toContain("MCP → Import from JSON")
      expect(config?.summary, id).toContain("Preserve existing entries")
      expect(config?.snippet, id).toContain(MCP_PACKAGE_SPEC)
      expect(auth?.title, id).toBe("Authenticate current MCP server")
      expect(auth?.command, id).toBe(`npx -y ${CLI_PACKAGE_SPEC} login --oauth`)
      expect(skills?.summary, id).toContain("Install the focused LyraShield workflows")
      expect(skills?.command, id).toBe(`npx -y ${CLI_PACKAGE_SPEC} skills install ${id}`)
      expect(verify?.summary, id).toContain("read-only LyraShield call")
      expect(verify?.summary, id).toContain("Native marketplace plugin availability is separate")
    }
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
    expect(wizard?.versionConstraints?.note).toContain("CLI")
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

  it("keeps scans explicit and makes hook installation available only as an opt-in", () => {
    const wizard = buildAgentWizard("claude-code", "https://app.lyrashieldai.com")
    const verify = wizard?.steps.find((step) => step.id === "verify")
    const hooks = wizard?.steps.find((step) => step.id === "hooks")

    expect(verify?.summary).toContain("Scans remain explicit")
    expect(verify?.command).toBe(`npx -y ${CLI_PACKAGE_SPEC} doctor`)
    expect(hooks?.note).toContain("Off by default")
    expect(hooks?.command).toBe(`npx -y ${CLI_PACKAGE_SPEC} hook install`)
    expect(hooks?.note).toContain("never starts a paid scan")
    expect(hooks?.note).toContain("preserves unrelated hook commands")
    expect(hooks?.note).not.toContain("delete .git/hooks/pre-commit")
    expect(hooks?.optional).toBe(true)
  })

  it("renders valid JSONC-compatible snippets and marks alternate transport optional", () => {
    for (const id of ["cline", "kilo-code"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      const config = wizard?.steps.find((step) => step.id === "config")
      const parsed = JSON.parse(config?.snippet ?? "null")
      expect(parsed?.[getAgent(id)!.rootKey!]?.lyrashield).toBeDefined()
      expect(config?.snippetPath).toBeTruthy()
      expect(config?.summary).toContain("preserving existing servers and comments")
      expect(wizard?.steps.find((step) => step.id === "config-remote")?.optional).toBe(true)
    }
  })

  it("authenticates before fresh stdio installation and pins the MCP fallback", () => {
    const wizard = buildAgentWizard("zed", "https://app.lyrashieldai.com")
    expect(wizard?.steps[0]?.id).toBe("api-key")
    expect(wizard?.steps[0]?.command).toBe(`npx -y ${CLI_PACKAGE_SPEC} login --oauth`)
    const guided = buildAgentWizard("jetbrains", "https://app.lyrashieldai.com")
    expect(guided?.steps.find((step) => step.id === "config")?.snippet).toContain(MCP_PACKAGE_SPEC)
    expect(guided?.steps.find((step) => step.id === "config")?.snippet).not.toContain(
      "LYRASHIELD_API_KEY"
    )
  })

  it("explains independent authentication and accurately gates unsupported rule writes", () => {
    const local = buildAgentWizard("mistral-vibe", "https://app.lyrashieldai.com")
    const remote = local?.steps.find((step) => step.id === "config-remote")
    expect(remote?.optional).toBe(true)
    expect(remote?.note).toContain("separate read-only API key")
    expect(remote?.note).toContain("CLI OAuth authenticates only local stdio")
    expect(remote?.note).toContain("Never commit")
    const rules = buildAgentWizard("cline", "https://app.lyrashieldai.com")?.steps.find(
      (step) => step.id === "rules"
    )
    expect(rules?.command).toBe(`npx -y ${CLI_PACKAGE_SPEC} rules add cline`)
    expect(rules?.note).toContain(`rules remove cline`)
    const piLocal = buildAgentWizard("pi", "https://app.lyrashieldai.com")?.steps.find(
      (step) => step.id === "config-local"
    )
    expect(piLocal?.note).toContain(`npx -y ${CLI_PACKAGE_SPEC} login --oauth`)
  })

  it("keeps web and cloud setup inside the client without local repository hooks", () => {
    for (const id of ["lovable", "replit-agent", "v0", "devin", "claude-web"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      expect(
        wizard?.steps.some((step) => step.id === "hooks"),
        id
      ).toBe(false)
      expect(wizard?.steps.find((step) => step.id === "verify")?.command, id).toBeUndefined()
      expect(wizard?.steps.find((step) => step.id === "api-key")?.note).toContain("read-only")
    }
  })

  it("offers the pinned skills installer while preserving guided client setup", () => {
    for (const id of ["picode", "devin-desktop", "mistral-vibe", "replit-agent"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      const skills = wizard?.steps.find((step) => step.id === "skills")
      expect(skills?.kind, id).toBe("skills")
      expect(skills?.command, id).toBe(`npx -y ${CLI_PACKAGE_SPEC} skills install ${id}`)
      expect(skills?.summary, id).toContain("Install the focused LyraShield workflows")
      expect(wizard?.steps.find((step) => step.id === "install")?.command, id).toBeUndefined()
    }
  })

  it("uses the pinned CLI config writer for clients with a matching install contract", () => {
    for (const id of ["vscode", "opencode", "gemini-cli", "copilot-cli"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      expect(wizard?.steps.find((step) => step.id === "install")?.command, id).toBe(
        `npx -y ${CLI_PACKAGE_SPEC} install ${id}`
      )
      expect(wizard?.steps.find((step) => step.id === "config")?.summary, id).toContain(
        "install command above can do this for you"
      )
    }
  })

  it("keeps Copilot cloud API-key setup separate from OAuth and hosted mutations", () => {
    const wizard = buildAgentWizard("github-copilot-cloud-agent", "https://app.lyrashieldai.com")
    expect(wizard?.surface).toBe("cloud")
    const auth = wizard?.steps.find((step) => step.id === "api-key")
    expect(auth?.command).toBeUndefined()
    expect(auth?.summary).toContain("read-only API key")
    expect(auth?.note).toContain("connect_required")
    expect(auth?.note).toContain("Never commit")
    expect(wizard?.steps.some((step) => step.id === "hooks")).toBe(false)
  })
})
