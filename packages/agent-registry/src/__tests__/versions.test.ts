import { describe, expect, it } from "vitest"
import { getAgent, getPreferredAgent, listAgents } from "../index"
import {
  CLI_CONFIG_WRITES_AVAILABLE,
  CLI_PACKAGE_SPEC,
  CLI_PACKAGE_VERSION,
  CLI_SKILLS_AVAILABLE,
  getPublishedCliInstallCommand,
  MCP_PACKAGE_SPEC,
} from "../versions"

describe("published package versions", () => {
  it("pins install commands to the latest published CLI and MCP packages", () => {
    expect(CLI_PACKAGE_VERSION).toBe("0.2.13")
    expect(CLI_PACKAGE_SPEC).toBe("lyrashield@0.2.13")
    expect(MCP_PACKAGE_SPEC).toBe("@lyrashield/mcp@0.2.11")
    expect(CLI_SKILLS_AVAILABLE).toBe(false)
    expect(CLI_CONFIG_WRITES_AVAILABLE).toBe(false)
  })

  it("returns a pinned CLI install command only for an exact published install contract", () => {
    const devin = getAgent("devin")
    const cursorPlugin = getAgent("cursor-agent-plugin")

    expect(devin).toBeDefined()
    expect(cursorPlugin).toBeDefined()
    expect(getPublishedCliInstallCommand(devin!)).toBe("npx -y lyrashield@0.2.13 install devin")
    expect(getPublishedCliInstallCommand(cursorPlugin!)).toBe(
      "npx -y lyrashield@0.2.13 install cursor-agent-plugin"
    )
  })

  it("withholds every config-file command until the published CLI has safe config writes", () => {
    const configAgents = listAgents().filter((agent) => agent.installStrategy === "config-file")

    expect(CLI_CONFIG_WRITES_AVAILABLE).toBe(false)
    expect(configAgents.length).toBeGreaterThan(0)
    for (const agent of configAgents) {
      expect(getPublishedCliInstallCommand(agent)).toBeNull()
    }
  })

  it("keeps commands manual when the public CLI targets a different preferred entry", () => {
    for (const id of ["cursor"]) {
      const legacyEntry = getAgent(id)
      const preferredEntry = getPreferredAgent(id)

      expect(legacyEntry).toBeDefined()
      expect(preferredEntry).toBeDefined()
      expect(preferredEntry?.id).not.toBe(legacyEntry?.id)
      expect(getPublishedCliInstallCommand(legacyEntry!)).toBeNull()
      expect(getPublishedCliInstallCommand(preferredEntry!)).toBe(
        `npx -y lyrashield@0.2.13 install ${preferredEntry?.id}`
      )
    }
  })

  it.each(["claude-code", "openai-codex", "github-copilot"])(
    "withholds %s plugin commands until a reviewed immutable release exists",
    (id) => {
      const legacy = getAgent(id)
      if (legacy) expect(getPublishedCliInstallCommand(legacy)).toBeNull()
      const preferred = getPreferredAgent(id)!
      expect(getPublishedCliInstallCommand(preferred)).toBeNull()
      expect(preferred.manualInstructions).toContain("reviewed matching immutable package release")
      expect(preferred.manualInstructions).not.toContain("marketplace add")
      expect(preferred.gotchas.join(" ")).not.toContain("ecryptoguru/lyrashield-marketplace")
    }
  )

  it("gates new and changed contracts, including Pi's formerly standalone setup", () => {
    for (const id of [
      "auggie",
      "qoder",
      "picode",
      "jetbrains",
      "kiro-agent-plugin",
      "github-copilot-cloud-agent",
      "augment-vscode",
      "augment-jetbrains",
    ]) {
      const agent = getAgent(id)
      expect(agent).toBeDefined()
      expect(getPublishedCliInstallCommand(agent!)).toBeNull()
    }

    expect(getAgent("pi")?.id).toBe("picode")
    expect(getPublishedCliInstallCommand(getAgent("pi")!)).toBeNull()
  })

  it("rejects same-ID entries when any install-contract field has drifted", () => {
    const agent = getAgent("devin")!
    const changedContracts = [
      { ...agent, rootKey: "changedRoot" },
      {
        ...agent,
        locations: [
          ...agent.locations,
          { scope: "project" as const, path: ".lyrashield/mcp.json", sharedByConvention: false },
        ],
      },
      { ...agent, credential: { kind: "ui-fields" as const } },
      {
        ...agent,
        transports: agent.transports.includes("stdio")
          ? agent.transports.filter((transport) => transport !== "stdio")
          : [...agent.transports, "stdio"],
      },
      { ...agent, transportFields: { stdio: { type: "candidate-format" } } },
      { ...agent, vendorCli: { command: "candidate-cli", args: [] } },
      {
        ...agent,
        pluginLocations: [
          { scope: "project" as const, path: ".lyrashield/plugin", sharedByConvention: false },
        ],
      },
      { ...agent, manualInstructions: "Changed setup behavior" },
    ]

    for (const changed of changedContracts) {
      expect(changed.id).toBe(agent.id)
      expect(changed.installStrategy).toBe(agent.installStrategy)
      expect(getPublishedCliInstallCommand(changed)).toBeNull()
    }
  })
})
