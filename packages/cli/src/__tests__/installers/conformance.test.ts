/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { getAgent } from "@lyrashield/agent-registry"
import { installAgent, uninstallAgent } from "../../installers/install.js"
import { parse as parseJsonc } from "jsonc-parser"

const API_URL = "https://app.lyrashieldai.com/api/v1"
const API_KEY = "lsk_testkey123"

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "lyrashield-cli-"))
}

function parseJsoncContent(content: string): Record<string, unknown> {
  return (parseJsonc(content) ?? {}) as Record<string, unknown>
}

const claude = getAgent("claude-code")!
const kilo = getAgent("kilo-code")!

describe("conformance: install/uninstall round-trips", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await tempDir()
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it("claude-code merge-safety keeps foreign servers and unrelated keys", async () => {
    const fixture = `{
  "mcpServers": {
    "acme": {
      "command": "npx",
      "args": ["acme-mcp"]
    }
  },
  "unrelated": true
}`
    await writeFile(path.join(cwd, ".mcp.json"), fixture, "utf-8")

    const result = await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
      inlineSecret: true,
    })

    expect(result.outcome).toBe("CONFIGURED")

    const content = await readFile(path.join(cwd, ".mcp.json"), "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    expect(parsed).toHaveProperty("unrelated", true)
    expect(parsed).toHaveProperty("mcpServers")
    const servers = parsed["mcpServers"] as Record<string, unknown>
    expect(servers).toHaveProperty("acme")
    expect(servers).toHaveProperty("lyrashield")
    const lyra = servers["lyrashield"] as Record<string, unknown>
    expect(lyra).toHaveProperty("command", "npx")
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp"])
    expect(lyra).toHaveProperty("env")
  })

  it("kilo-code merge-safety preserves JSONC comments and foreign servers", async () => {
    const fixture = `// Kilo Code settings
{
  // other server
  "mcp": {
    "acme": {
      "command": "npx",
      "args": ["acme-mcp"]
    }
  },
  "note": "keep me"
}`
    await writeFile(path.join(cwd, "kilo.jsonc"), fixture, "utf-8")

    const result = await installAgent({
      agent: kilo,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
    })

    expect(result.outcome).toBe("CONFIGURED")

    const content = await readFile(path.join(cwd, "kilo.jsonc"), "utf-8")
    expect(content).toContain("// Kilo Code settings")
    expect(content).toContain("// other server")
    const parsed = parseJsoncContent(content)
    expect(parsed).toHaveProperty("note", "keep me")
    expect(parsed).toHaveProperty("mcp")
    const mcp = parsed["mcp"] as Record<string, unknown>
    expect(mcp).toHaveProperty("acme")
    expect(mcp).toHaveProperty("lyrashield")
    const lyra = mcp["lyrashield"] as Record<string, unknown>
    expect(lyra).toHaveProperty("type", "local")
    expect(JSON.stringify(lyra)).toContain("{env:LYRASHIELD_API_KEY}")
  })

  it("claude-code idempotency is ALREADY_CONFIGURED on second install", async () => {
    await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
      inlineSecret: true,
    })

    const second = await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
      inlineSecret: true,
    })

    expect(second.outcome).toBe("ALREADY_CONFIGURED")
  })

  it("claude-code uninstall removes the entry while preserving fixture", async () => {
    const fixture = `{
  "mcpServers": {
    "acme": {
      "command": "npx",
      "args": ["acme-mcp"]
    }
  },
  "unrelated": true
}`
    await writeFile(path.join(cwd, ".mcp.json"), fixture, "utf-8")

    await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
      inlineSecret: true,
    })

    await uninstallAgent(claude, { scope: "project", cwd })

    const content = await readFile(path.join(cwd, ".mcp.json"), "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    expect(parsed).toHaveProperty("unrelated", true)
    expect(parsed).toHaveProperty("mcpServers")
    const servers = parsed["mcpServers"] as Record<string, unknown>
    expect(servers).toHaveProperty("acme")
    expect(servers).not.toHaveProperty("lyrashield")
  })

  it("shared config refuses to inline the secret by default", async () => {
    const result = await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
    })

    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toMatch(/shared config/i)
  })

  it("interpolated agent writes no literal API key", async () => {
    const result = await installAgent({
      agent: kilo,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
    })

    expect(result.outcome).toBe("CONFIGURED")

    const content = await readFile(path.join(cwd, "kilo.jsonc"), "utf-8")
    expect(content).not.toContain(API_KEY)
    expect(content).toContain("{env:LYRASHIELD_API_KEY}")
  })

  it("inline-secret flag can write the literal key with a warning", async () => {
    const result = await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      apiKey: API_KEY,
      scope: "project",
      cwd,
      all: true,
      inlineSecret: true,
    })

    expect(result.outcome).toBe("CONFIGURED")
    expect(result.message).toMatch(/secret/i)

    const content = await readFile(path.join(cwd, ".mcp.json"), "utf-8")
    expect(content).toContain(API_KEY)
  })
})
