import { describe, expect, it } from "vitest"
import {
  AGENTS,
  agentEntrySchema,
  getAgent,
  listAgents,
  agentsByStrategy,
  renderConfig,
  renderEntry,
} from "../index.js"
import type { AgentEntry, InstallOptions, Transport } from "../types.js"

const TEST_API_URL = "https://app.lyrashieldai.com/api/mcp"
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
    apiUrl: TEST_API_URL,
    apiKey: TEST_API_KEY,
    secretMode,
    serverName: "lyrashield",
  }
}

describe("agent registry", () => {
  it("contains exactly 15 agents", () => {
    expect(AGENTS).toHaveLength(15)
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
        LYRASHIELD_API_URL: TEST_API_URL,
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
          LYRASHIELD_API_URL: TEST_API_URL,
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
        LYRASHIELD_API_URL: TEST_API_URL,
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
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
      env: {
        LYRASHIELD_API_KEY: "{env:LYRASHIELD_API_KEY}",
        LYRASHIELD_API_URL: TEST_API_URL,
      },
    })
  })

  it("windsurf — remote uses `serverUrl` instead of `url`", () => {
    const agent = getAgent("windsurf")!
    const opts = testOptions(agent, "remote-http")
    const entry = renderEntry(agent, opts)
    expect(entry.rootKey).toBe("mcpServers")
    expect(entry.value).toMatchObject({
      serverUrl: TEST_API_URL,
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
    })
    expect(entry.value).not.toHaveProperty("url")
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
    "Windsurf's remote form uses `serverUrl`, not `url`",
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

  it("listAgents returns all 15 entries", () => {
    expect(listAgents()).toHaveLength(15)
    expect(listAgents()).toBe(AGENTS)
  })

  it("agentsByStrategy filters by strategy", () => {
    const configFile = agentsByStrategy("config-file")
    const vendorCli = agentsByStrategy("vendor-cli")
    const guided = agentsByStrategy("guided-manual")

    expect(configFile.length).toBeGreaterThan(0)
    expect(vendorCli.length).toBe(1)
    expect(guided.length).toBeGreaterThan(0)

    expect(configFile.every((a) => a.installStrategy === "config-file")).toBe(true)
    expect(vendorCli.every((a) => a.installStrategy === "vendor-cli")).toBe(true)
    expect(guided.every((a) => a.installStrategy === "guided-manual")).toBe(true)
  })
})
