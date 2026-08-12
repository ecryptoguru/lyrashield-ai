import { describe, expect, it } from "vitest"
import {
  AGENTS,
  agentEntrySchema,
  getAgent,
  getPreferredAgent,
  listAgents,
  listPreferredAgents,
  agentsByStrategy,
  renderConfig,
  renderEntry,
} from "../index.js"
import type { AgentEntry, InstallOptions, Transport } from "../types.js"

const TEST_BASE_URL = "https://app.lyrashieldai.com"
const TEST_MCP_URL = "https://app.lyrashieldai.com/api/mcp"
const TEST_API_KEY = "lsk_test_lyrashield_api_key"

function testOptions(agent: AgentEntry, transport: Transport): InstallOptions {
  let secretMode: InstallOptions["secretMode"] = "inline"
  if (agent.credential.kind === "interpolated-env") {
    secretMode = "interpolated"
  } else if (agent.credential.kind === "shell-env") {
    secretMode = "shell"
  }

  return {
    transport,
    apiUrl: TEST_BASE_URL,
    apiKey: TEST_API_KEY,
    secretMode,
    serverName: "lyrashield",
  }
}

describe("agent registry", () => {
  it("contains at least 15 agents", () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(15)
  })

  // Exact-count guard: when an agent is added or removed, this test fails,
  // forcing the author to update the docs prose on /docs/integrations
  // (which hardcodes counts like "15 agents" and "9 of the 15").
  it("exact total and per-strategy counts match the documented registry", () => {
    const configFile = AGENTS.filter((a) => a.installStrategy === "config-file")
    const vendorCli = AGENTS.filter((a) => a.installStrategy === "vendor-cli")
    const guided = AGENTS.filter((a) => a.installStrategy === "guided-manual")
    const plugin = AGENTS.filter((a) => a.installStrategy === "agent-plugin")

    // Total registered agents (non-plugin + plugin).
    expect(AGENTS.length).toBe(30)
    // Plugin agents (launch clients).
    expect(plugin.length).toBe(6)
    // Non-plugin agents — the docs index references this set.
    expect(configFile.length + vendorCli.length + guided.length).toBe(24)
  })

  it("has unique ids and display names", () => {
    const ids = AGENTS.map((a) => a.id)
    const names = AGENTS.map((a) => a.displayName)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it("validates every entry against agentEntrySchema", () => {
    for (const agent of AGENTS) {
      const result = agentEntrySchema.safeParse(agent)
      if (!result.success) {
        console.error(agent.id, result.error)
      }
      expect(result.success).toBe(true)
    }
  })

  it("every agent has a source with a valid ISO checkedOn date", () => {
    const checkedOns: string[] = []
    for (const agent of AGENTS) {
      expect(agent.source).toBeDefined()
      expect(agent.source?.checkedOn).toBeDefined()
      const parsed = Date.parse(agent.source!.checkedOn!)
      expect(Number.isNaN(parsed)).toBe(false)
      checkedOns.push(agent.source!.checkedOn!)
    }

    const oldest = new Date(Math.min(...checkedOns.map((d) => new Date(d).getTime())))
    const daysSince = (Date.now() - oldest.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince > 365) {
      console.warn(
        `Oldest source.checkedOn (${oldest.toISOString().slice(0, 10)}) is ${Math.floor(daysSince)} days old.`
      )
    }
  })
})

describe("preferred agent integrations", () => {
  it("routes confirmed plugin clients to one primary install instead of a duplicate config entry", () => {
    expect(getPreferredAgent("claude-code")?.id).toBe("claude-code-agent-plugin")
    expect(getPreferredAgent("cursor")?.id).toBe("cursor-agent-plugin")
    expect(getPreferredAgent("openai-codex")?.id).toBe("openai-codex-agent-plugin")
  })

  // These two ship only as plugin entries, so before they were mapped
  // `getPreferredAgent` returned undefined and the documented
  // `lyrashield install <agent>` failed as an unknown agent.
  it("resolves plugin-only clients that have no config-file entry", () => {
    expect(getAgent("github-copilot")).toBeUndefined()
    expect(getAgent("kiro")).toBeUndefined()
    expect(getPreferredAgent("github-copilot")?.id).toBe("github-copilot-agent-plugin")
    expect(getPreferredAgent("kiro")?.id).toBe("kiro-agent-plugin")
  })

  // VS Code keeps its verified .vscode/mcp.json path: no generated VS Code
  // plugin shim exists, so preferring the plugin would reroute a working
  // install onto an unverified one.
  it("keeps VS Code on its verified config-file install path", () => {
    expect(getPreferredAgent("vscode")?.id).toBe("vscode")
    expect(getPreferredAgent("vscode")?.installStrategy).toBe("config-file")
  })

  it("shows one dashboard choice for each documented integration", () => {
    const docsSlugs = listPreferredAgents().map((agent) => agent.docsSlug)
    expect(new Set(docsSlugs).size).toBe(docsSlugs.length)
  })
})

describe("renderConfig snapshot — every agent × every transport", () => {
  for (const agent of AGENTS) {
    for (const transport of agent.transports) {
      it(`${agent.id} × ${transport}`, () => {
        const opts = testOptions(agent, transport)

        if (agent.installStrategy !== "config-file") {
          expect(() => renderConfig(agent, opts)).toThrowErrorMatchingSnapshot()
          return
        }

        if (agent.format === "jsonc") {
          expect(() => renderConfig(agent, opts)).toThrowErrorMatchingSnapshot()
          return
        }

        const { content, format } = renderConfig(agent, opts)
        expect(format).toBe(agent.format)
        expect(content).toMatchSnapshot()
      })
    }
  }
})

describe("renderEntry returns correct structural patch", () => {
  it("vscode — root is `servers` and stdio has type", () => {
    const agent = getAgent("vscode")!
    const opts = testOptions(agent, "stdio")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("servers")
    expect(entry.entryKey).toBe("lyrashield")
    expect(entry.value).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
      env: {
        LYRASHIELD_API_KEY: TEST_API_KEY,
        LYRASHIELD_API_URL: TEST_BASE_URL,
      },
    })
  })

  it("zed — root is `context_servers` and command uses `path`", () => {
    const agent = getAgent("zed")!
    const opts = testOptions(agent, "stdio")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("context_servers")
    expect(entry.value).toMatchObject({
      command: {
        path: "npx",
        args: ["-y", "@lyrashield/mcp"],
        env: {
          LYRASHIELD_API_KEY: TEST_API_KEY,
          LYRASHIELD_API_URL: TEST_BASE_URL,
        },
      },
    })
  })

  it("openai-codex — root is `mcp_servers` and uses `env_vars`", () => {
    const agent = getAgent("openai-codex")!
    const opts = testOptions(agent, "stdio")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("mcp_servers")
    expect(entry.value).toMatchObject({
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
      env_vars: {
        LYRASHIELD_API_KEY: TEST_API_KEY,
        LYRASHIELD_API_URL: TEST_BASE_URL,
      },
    })
  })

  it("opencode — root is `mcp` and uses `{env:VAR}` interpolation", () => {
    const agent = getAgent("opencode")!
    const opts = testOptions(agent, "stdio")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("mcp")
    expect(entry.value).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@lyrashield/mcp"],
      environment: {
        LYRASHIELD_API_KEY: "{env:LYRASHIELD_API_KEY}",
        LYRASHIELD_API_URL: TEST_BASE_URL,
      },
    })
  })

  it("Devin is configured through its MCP Marketplace, not a legacy Windsurf file", () => {
    const agent = getAgent("devin")!
    expect(agent.displayName).toBe("Devin")
    expect(agent.installStrategy).toBe("guided-manual")
    expect(agent.locations).toEqual([])
    expect(agent.source?.url).toBe("https://docs.devin.ai/work-with-devin/mcp")
    expect(getAgent("windsurf")).toBeUndefined()
  })

  it("antigravity — remote uses `serverUrl` instead of `url`", () => {
    const agent = getAgent("antigravity")!
    const opts = testOptions(agent, "remote-http")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("mcpServers")
    expect(entry.value).toMatchObject({
      serverUrl: TEST_MCP_URL,
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
    })
    expect(entry.value).not.toHaveProperty("url")
  })

  it("copilot-cli — stdio declares `type: local` and remote `type: http`", () => {
    const agent = getAgent("copilot-cli")!
    const stdioEntry = renderEntry(agent, testOptions(agent, "stdio"))
    expect(stdioEntry.rootKey).toBe("mcpServers")
    expect(stdioEntry.value).toMatchObject({
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
      type: "local",
    })
    const remoteEntry = renderEntry(agent, testOptions(agent, "remote-http"))
    expect(remoteEntry.value).toMatchObject({
      url: TEST_MCP_URL,
      type: "http",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
    })
  })
})

describe("gotchas from §3.4 are represented", () => {
  const gotchaMarkers = [
    "VS Code uses `servers`, not `mcpServers`",
    "Zed uses `context_servers`",
    "OpenAI Codex uses `env_vars`, not `env`",
    "single-brace `{env:VAR}`",
    "Gemini CLI strips env vars whose names contain KEY, TOKEN or SECRET",
    "Cline defaults to legacy SSE",
    "Settings → MCP Marketplace → Add Your Own",
    "Kilo Code's file is JSONC",
    "Amp takes no --env flags",
    "JetBrains has no file we can write",
    "declare `transport: stdio` explicitly",
  ]

  for (const marker of gotchaMarkers) {
    it(`gotcha: ${marker}`, () => {
      const found = AGENTS.some((agent) => agent.gotchas.some((g) => g.includes(marker)))
      expect(found).toBe(true)
    })
  }

  it("every agent has at least one gotcha", () => {
    for (const agent of AGENTS) {
      expect(agent.gotchas.length).toBeGreaterThan(0)
    }
  })
})

describe("registry helpers", () => {
  it("getAgent returns the requested entry or undefined", () => {
    expect(getAgent("cursor")?.id).toBe("cursor")
    expect(getAgent("not-real")).toBeUndefined()
  })

  it("listAgents returns at least 15 entries", () => {
    expect(listAgents().length).toBeGreaterThanOrEqual(15)
    expect(listAgents()).toBe(AGENTS)
  })

  it("agentsByStrategy filters by strategy", () => {
    const configFile = agentsByStrategy("config-file")
    const vendorCli = agentsByStrategy("vendor-cli")
    const guided = agentsByStrategy("guided-manual")
    const pluginAgents = agentsByStrategy("agent-plugin")

    expect(configFile.length).toBeGreaterThan(0)
    expect(vendorCli.length).toBeGreaterThanOrEqual(1)
    expect(guided.length).toBeGreaterThan(0)
    expect(pluginAgents.length).toBe(6)

    expect(configFile.every((a) => a.installStrategy === "config-file")).toBe(true)
    expect(vendorCli.every((a) => a.installStrategy === "vendor-cli")).toBe(true)
    expect(guided.every((a) => a.installStrategy === "guided-manual")).toBe(true)
    expect(pluginAgents.every((a) => a.installStrategy === "agent-plugin")).toBe(true)
  })
})

describe("agent-plugin entries", () => {
  const pluginAgentIds = [
    "claude-code-agent-plugin",
    "cursor-agent-plugin",
    "vscode-agent-plugin",
    "openai-codex-agent-plugin",
    "github-copilot-agent-plugin",
    "kiro-agent-plugin",
  ]

  for (const id of pluginAgentIds) {
    it(`${id} exists and has pluginLocations`, () => {
      const agent = getAgent(id)
      expect(agent).toBeDefined()
      expect(agent!.installStrategy).toBe("agent-plugin")
      expect(agent!.format).toBeNull()
      expect(agent!.rootKey).toBeNull()
      expect(agent!.locations).toEqual([])
      expect(agent!.pluginLocations).toBeDefined()
      expect(agent!.pluginLocations!.length).toBeGreaterThan(0)
    })
  }

  it("existing non-plugin entries are unchanged", () => {
    const claude = getAgent("claude-code")
    expect(claude?.installStrategy).toBe("config-file")
    expect(claude?.format).toBe("json")

    const codex = getAgent("openai-codex")
    expect(codex?.installStrategy).toBe("config-file")
    expect(codex?.format).toBe("toml")
  })

  it("renderConfig throws a clear error for agent-plugin entries", () => {
    const agent = getAgent("claude-code-agent-plugin")!
    expect(() =>
      renderConfig(agent, {
        transport: "stdio",
        apiUrl: TEST_BASE_URL,
        apiKey: TEST_API_KEY,
        secretMode: "inline",
        serverName: "lyrashield",
      })
    ).toThrow(/agent-plugin/)
  })
})
