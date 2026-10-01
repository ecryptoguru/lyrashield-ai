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

  it("does not ask Agent Plugin users to configure an MCP server a second time", () => {
    const wizard = buildAgentWizard("openai-codex-agent-plugin", "https://app.lyrashieldai.com")

    expect(wizard?.steps.some((step) => step.id === "config")).toBe(false)
    expect(wizard?.steps.find((step) => step.id === "api-key")?.command).toBeUndefined()
    expect(wizard?.steps.find((step) => step.id === "api-key")?.summary).toContain("OAuth in")
    expect(wizard?.steps.some((step) => step.kind === "rules")).toBe(false)
  })

  it("keeps Claude's unpublished plugin path non-actionable and points to current MCP guidance", () => {
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
    expect(fallback?.optional).toBe(true)
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
    expect(wizard?.steps.find((step) => step.id === "api-key")?.summary).toContain("OAuth in")
    expect(wizard?.steps.find((step) => step.id === "verify")?.note).toContain("read-only")
  })

  it("does not present the published CLI's obsolete Pi preview as native MCP setup", () => {
    const install = buildAgentWizard("pi", "https://app.lyrashieldai.com")?.steps.find(
      (step) => step.id === "install"
    )
    expect(install?.command).toBeUndefined()
    expect(install?.summary).toContain("pi mcp add")
    expect(install?.summary).toContain("published CLI 0.2.13")
    expect(install?.summary).toContain("predates Pi's native MCP")
    expect(install?.summary).toContain("Skills installer remains pending release")
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

  it("separates Augment's published MCP tools from the unreleased workflow bundle", () => {
    for (const id of ["augment-vscode", "augment-jetbrains"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      const install = wizard?.steps.find((step) => step.id === "install")
      const config = wizard?.steps.find((step) => step.id === "config")
      const auth = wizard?.steps.find((step) => step.id === "api-key")
      const skills = wizard?.steps.find((step) => step.id === "skills")
      const verify = wizard?.steps.find((step) => step.id === "verify")

      expect(wizard?.distribution?.state, id).toBe("PREPARATION")
      expect(install?.title, id).toBe("Connect current MCP tools")
      expect(install?.summary, id).toContain(
        `published direct-MCP baseline uses ${CLI_PACKAGE_SPEC}`
      )
      expect(install?.summary, id).toContain(MCP_PACKAGE_SPEC)
      expect(install?.summary, id).toContain("MCP tools only")
      expect(install?.command, id).toBeUndefined()
      expect(config?.summary, id).toContain("do not pair it with candidate workflow skills")
      expect(config?.snippet, id).toContain(MCP_PACKAGE_SPEC)
      expect(auth?.title, id).toBe("Authenticate current MCP server")
      expect(auth?.command, id).toBe(`npx -y ${CLI_PACKAGE_SPEC} login --oauth`)
      expect(skills?.summary, id).toContain("published MCP baseline provides direct tools only")
      expect(skills?.summary, id).toContain("coordinated candidate release")
      expect(skills?.command, id).toBeUndefined()
      expect(verify?.summary, id).toContain(
        "Native workflow skills remain a separate, unpublished release"
      )
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

  it("keeps scans explicit and gives safe optional hook guidance", () => {
    const wizard = buildAgentWizard("claude-code", "https://app.lyrashieldai.com")
    const verify = wizard?.steps.find((step) => step.id === "verify")
    const hooks = wizard?.steps.find((step) => step.id === "hooks")

    expect(verify?.summary).toContain("Scans remain explicit")
    expect(verify?.command).toBe(`npx -y ${CLI_PACKAGE_SPEC} doctor`)
    expect(hooks?.note).toContain("safer offline hook installer is prepared")
    expect(hooks?.command).toBeUndefined()
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

  it("explains independent authentication for alternate transports and gates unpublished rule writes", () => {
    const local = buildAgentWizard("mistral-vibe", "https://app.lyrashieldai.com")
    const remote = local?.steps.find((step) => step.id === "config-remote")
    expect(remote?.optional).toBe(true)
    expect(remote?.note).toContain("separate read-only API key")
    expect(remote?.note).toContain("CLI OAuth authenticates only local stdio")
    expect(remote?.note).toContain("Never commit")
    const rules = buildAgentWizard("cline", "https://app.lyrashieldai.com")?.steps.find(
      (step) => step.id === "rules"
    )
    expect(rules?.command).toBeUndefined()
    expect(rules?.note).toContain("next CLI release")
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

  it("separates native skills from rules and does not copy unpublished installers", () => {
    for (const id of ["picode", "devin-desktop", "mistral-vibe", "replit-agent"]) {
      const wizard = buildAgentWizard(id, "https://app.lyrashieldai.com")
      const skills = wizard?.steps.find((step) => step.id === "skills")
      expect(skills?.kind, id).toBe("skills")
      expect(skills?.command, id).toBeUndefined()
      expect(skills?.summary, id).toContain("next release")
      expect(wizard?.steps.find((step) => step.id === "install")?.command, id).toBeUndefined()
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
