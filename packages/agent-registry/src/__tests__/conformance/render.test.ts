import { describe, expect, it } from "vitest"
import { parse as parseJsonc } from "jsonc-parser"
import * as TOML from "@iarna/toml"
import YAML from "yaml"
import { AGENTS, renderConfig } from "../../index.js"
import type { ConfigFormat, InstallOptions, Transport } from "../../types.js"

const API_URL = "https://app.lyrashieldai.com/api/v1"
const API_KEY = "lsk_testkey123"
const SERVER_NAME = "lyrashield"

function parseContent(format: ConfigFormat, content: string): Record<string, unknown> {
  if (format === "json") return JSON.parse(content) as Record<string, unknown>
  if (format === "jsonc") return (parseJsonc(content) ?? {}) as Record<string, unknown>
  if (format === "toml") return TOML.parse(content) as Record<string, unknown>
  return YAML.parse(content) as Record<string, unknown>
}

function renderOpts(transport: Transport, secretMode: InstallOptions["secretMode"]): InstallOptions {
  return {
    transport,
    apiUrl: API_URL,
    secretMode,
    apiKey: API_KEY,
    serverName: SERVER_NAME,
  }
}

const configFileAgents = AGENTS.filter((a) => a.installStrategy === "config-file")

describe("conformance: renderConfig round-trips through the format parser", () => {
  for (const agent of configFileAgents) {
    for (const transport of agent.transports) {
      const caseName = `${agent.id} × ${transport}`

      it(`${caseName} — interpolated secret is safe`, () => {
        const { content, format } = renderConfig(agent, renderOpts(transport, "interpolated"))

        // The raw content must contain the API URL but never the literal test key.
        expect(content).toContain(API_URL)
        expect(content).not.toContain(API_KEY)

        const parsed = parseContent(format, content)
        expect(parsed, "rootKey must be present at the top level").toHaveProperty(agent.rootKey!)

        const root = parsed[agent.rootKey!] as Record<string, unknown>
        expect(root, "lyrashield entry must exist under rootKey").toHaveProperty(SERVER_NAME)

        const entry = root[SERVER_NAME] as Record<string, unknown>

        // Transport-agnostic shape.
        if (transport === "stdio") {
          if (agent.commandWrapperKey) {
            // Zed: command object uses `path`, not `command`.
            expect(entry).toHaveProperty(agent.commandWrapperKey)
            const wrapper = entry[agent.commandWrapperKey] as Record<string, unknown>
            expect(wrapper).toHaveProperty("path")
            expect(wrapper).toHaveProperty("args")
            expect(wrapper).toHaveProperty("env")
          } else {
            expect(entry).toHaveProperty("command")
            expect(entry).toHaveProperty("args")
            if (agent.credential.kind === "env-names") {
              expect(entry).toHaveProperty(agent.credential.field)
            } else {
              expect(entry).toHaveProperty("env")
            }
          }
        } else {
          expect(entry).toHaveProperty("headers")
        }

        // Vendor-specific structural gotchas.
        if (agent.id === "vscode") {
          expect(agent.rootKey).toBe("servers")
          expect(entry).toHaveProperty("type")
        }

        if (agent.id === "openai-codex") {
          expect(agent.rootKey).toBe("mcp_servers")
          expect(entry).toHaveProperty("env_vars")
          expect(entry).not.toHaveProperty("env")
        }

        if (agent.id === "opencode" || agent.id === "kilo-code") {
          expect(agent.rootKey).toBe("mcp")
          expect(entry).toHaveProperty("type")
          if (transport === "stdio") {
            expect(entry.type).toBe("local")
          } else {
            expect(entry.type).toBe("remote")
          }
          // Single-brace {env:VAR} syntax for the API key.
          expect(content).toContain("{env:LYRASHIELD_API_KEY}")
        }

        if (agent.id === "windsurf" && transport === "remote-http") {
          expect(entry).toHaveProperty("serverUrl")
          expect(entry).not.toHaveProperty("url")
          expect(entry.serverUrl).toBe(API_URL)
        }

        if (agent.id === "gemini-cli") {
          expect(SERVER_NAME).not.toContain("_")
        }

        // Anything rendered must parse back to the expected root key.
        expect(format).toBe(agent.format)
        expect(content).toMatchSnapshot(`${caseName} — interpolated`)
      })

      it(`${caseName} — inline secret may contain the literal key`, () => {
        const { content } = renderConfig(agent, renderOpts(transport, "inline"))
        expect(content).toContain(API_KEY)
        expect(content).toMatchSnapshot(`${caseName} — inline`)
      })
    }
  }
})
