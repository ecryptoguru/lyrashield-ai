import { describe, expect, it } from "vitest"
import { parse as parseJsonc } from "jsonc-parser"
import * as TOML from "@iarna/toml"
import YAML from "yaml"
import { AGENTS, renderConfig } from "../../index.js"
import type { ConfigFormat, InstallOptions, Transport } from "../../types.js"

const API_URL = "https://app.lyrashieldai.com"
const API_KEY = "lsk_testkey123"
const SERVER_NAME = "lyrashield"

function parseContent(format: ConfigFormat, content: string): Record<string, unknown> {
  if (format === "json") return JSON.parse(content) as Record<string, unknown>
  if (format === "jsonc") return (parseJsonc(content) ?? {}) as Record<string, unknown>
  if (format === "toml") return TOML.parse(content) as Record<string, unknown>
  return YAML.parse(content) as Record<string, unknown>
}

function renderOpts(
  transport: Transport,
  secretMode: InstallOptions["secretMode"]
): InstallOptions {
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
        if (agent.format === "jsonc") {
          expect(() =>
            renderConfig(agent, renderOpts(transport, "interpolated"))
          ).toThrowErrorMatchingSnapshot(`${caseName} — interpolated`)
          return
        }

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
          } else if (agent.stdioStyle === "array-command-environment") {
            // MiMo Code: command is an array and env lives under `environment` (no `args`).
            expect(entry).toHaveProperty("command")
            expect(Array.isArray(entry.command)).toBe(true)
            expect(entry).toHaveProperty("environment")
            expect(entry).not.toHaveProperty("args")
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

        // Data-driven structural checks.
        const transportType = agent.transportFields?.[transport]?.type
        if (transportType) {
          expect(entry).toHaveProperty("type")
          expect(entry.type).toBe(transportType)
        }

        if (agent.credential.kind === "env-names") {
          expect(entry).not.toHaveProperty("env")
        }

        if (agent.credential.kind === "interpolated-env") {
          expect(content).toContain(agent.credential.syntax)
        }

        if (transport === "remote-http" && agent.transportFields?.["remote-http"]?.serverUrl) {
          expect(entry).toHaveProperty("serverUrl")
          expect(entry).not.toHaveProperty("url")
          expect(entry.serverUrl).toBe(API_URL + "/api/mcp")
        }

        if (agent.serverNamePattern) {
          // eslint-disable-next-line security/detect-non-literal-regexp
          expect(new RegExp(agent.serverNamePattern).test(SERVER_NAME)).toBe(true)
        }

        // Anything rendered must parse back to the expected root key.
        expect(format).toBe(agent.format)
        expect(content).toMatchSnapshot(`${caseName} — interpolated`)
      })

      it(`${caseName} — inline secret may contain the literal key`, () => {
        if (agent.format === "jsonc") {
          expect(() =>
            renderConfig(agent, renderOpts(transport, "inline"))
          ).toThrowErrorMatchingSnapshot(`${caseName} — inline`)
          return
        }

        const { content } = renderConfig(agent, renderOpts(transport, "inline"))
        expect(content).toContain(API_KEY)
        expect(content).toMatchSnapshot(`${caseName} — inline`)
      })
    }
  }

  describe("deriveMcpUrl URL normalization", () => {
    it("strips a stale /api suffix from the remote HTTP endpoint", () => {
      const cursor = AGENTS.find((a) => a.id === "cursor")!
      const { content } = renderConfig(cursor, {
        transport: "remote-http",
        apiUrl: "https://app.lyrashieldai.com/api",
        secretMode: "interpolated",
        apiKey: API_KEY,
        serverName: SERVER_NAME,
      })
      const parsed = parseContent("json", content)
      const root = parsed[cursor.rootKey!] as Record<string, unknown>
      const entry = root[SERVER_NAME] as Record<string, unknown>
      expect(entry.url).toBe("https://app.lyrashieldai.com/api/mcp")
    })

    it("strips a stale /api/v1 suffix from the remote HTTP endpoint", () => {
      const cursor = AGENTS.find((a) => a.id === "cursor")!
      const { content } = renderConfig(cursor, {
        transport: "remote-http",
        apiUrl: "https://app.lyrashieldai.com/api/v1",
        secretMode: "interpolated",
        apiKey: API_KEY,
        serverName: SERVER_NAME,
      })
      const parsed = parseContent("json", content)
      const root = parsed[cursor.rootKey!] as Record<string, unknown>
      const entry = root[SERVER_NAME] as Record<string, unknown>
      expect(entry.url).toBe("https://app.lyrashieldai.com/api/mcp")
    })
  })
})
