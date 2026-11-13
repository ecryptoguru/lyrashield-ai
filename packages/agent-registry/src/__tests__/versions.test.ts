import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const userGuide = readFileSync(resolve(repositoryRoot, "docs/user-guide.md"), "utf8")

describe("release package versions", () => {
  it("pins install commands to the coordinated CLI and MCP release", () => {
    expect(CLI_PACKAGE_VERSION).toBe("0.2.14")
    expect(CLI_PACKAGE_SPEC).toBe(`lyrashield@${CLI_PACKAGE_VERSION}`)
    expect(MCP_PACKAGE_SPEC).toBe("@lyrashield/mcp@0.2.12")
    expect(CLI_SKILLS_AVAILABLE).toBe(true)
    expect(CLI_CONFIG_WRITES_AVAILABLE).toBe(true)
    expect(userGuide).toContain("safe config writer")
    expect(userGuide).toContain(
      "write only for client configurations covered by the published install contract"
    )
  })

  it("returns a pinned CLI install command only for an exact published install contract", () => {
    const devin = getAgent("devin")
    expect(devin).toBeDefined()
    expect(getPublishedCliInstallCommand(devin!)).toBe(`npx -y ${CLI_PACKAGE_SPEC} install devin`)
  })

  it("offers config-file commands only for unchanged contracts supported by the pinned safe writer", () => {
    const configAgents = listAgents().filter((agent) => agent.installStrategy === "config-file")

    expect(CLI_CONFIG_WRITES_AVAILABLE).toBe(true)
    expect(configAgents.length).toBeGreaterThan(0)
    for (const agent of configAgents) {
      const command = getPublishedCliInstallCommand(agent)
      if (command) expect(command).toBe(`npx -y ${CLI_PACKAGE_SPEC} install ${agent.id}`)
    }
    for (const id of ["vscode", "opencode", "gemini-cli", "copilot-cli"]) {
      expect(getPublishedCliInstallCommand(getAgent(id)!)).toBe(
        `npx -y ${CLI_PACKAGE_SPEC} install ${id}`
      )
    }
    expect(getPublishedCliInstallCommand(getAgent("openai-codex")!)).toBeNull()
  })

  it("keeps active CLI package pins aligned with the published registry pin", () => {
    const trackedFiles = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8" }
    )
      .split("\0")
      .filter(Boolean)
    const textFile = /\.(?:md|mdx|astro|ts|tsx|mts|cts|mjs|cjs|json|jsonc|yml|yaml|toml|txt)$/i
    const historicalPins = new Set([
      "packages/agent-registry/src/versions.ts",
      "docs/marketplace/CLIENT-CONTRACTS.md",
    ])
    const references: Array<{ path: string; version: string }> = []

    for (const path of trackedFiles) {
      if (!textFile.test(path) || historicalPins.has(path)) continue
      const content = readFileSync(resolve(repositoryRoot, path), "utf8")
      for (const match of content.matchAll(/lyrashield@(\d+\.\d+\.\d+)(?![.\d])/g)) {
        references.push({ path, version: match[1]! })
      }
    }

    expect(references.length).toBeGreaterThan(100)
    expect(references.filter(({ version }) => version !== CLI_PACKAGE_VERSION)).toEqual([])
  })

  it.each(["claude-code", "openai-codex", "github-copilot", "cursor"])(
    "keeps %s plugin activation guided until public listing and runtime checks pass",
    (id) => {
      const legacy = getAgent(id)
      if (legacy) expect(getPublishedCliInstallCommand(legacy)).toBeNull()
      const preferred = getPreferredAgent(id)!
      expect(getPublishedCliInstallCommand(preferred)).toBeNull()
      expect(preferred.manualInstructions).toContain("public listing")
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
    expect(getAgent("pi")?.manualInstructions).toContain("skills install pi")
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
      { ...agent, remoteAuthConfig: { headersField: "candidate_headers" } },
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
