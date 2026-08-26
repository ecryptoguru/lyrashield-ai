/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { getAgent } from "@lyrashield/agent-registry"
import { installAgent, uninstallAgent } from "../../installers/install.js"
import { mergeFile } from "../../installers/merge.js"
import { parse as parseJsonc } from "jsonc-parser"
import * as TOML from "@iarna/toml"
import YAML from "yaml"

const API_URL = "https://app.lyrashieldai.com"
const API_KEY = "lsk_testkey123"

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "lyrashield-cli-"))
}

async function ignoreSharedConfig(cwd: string): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd })
  await writeFile(path.join(cwd, ".gitignore"), ".mcp.json\n", "utf-8")
}

function parseJsoncContent(content: string): Record<string, unknown> {
  return (parseJsonc(content) ?? {}) as Record<string, unknown>
}

const claude = getAgent("claude-code")!
const kilo = getAgent("kilo-code")!
const aider = getAgent("aider")!

describe("conformance: install/uninstall round-trips", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await tempDir()
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it("prints an executable stdio command for guided-manual agents", async () => {
    const result = await installAgent({
      agent: aider,
      transport: "stdio",
      apiUrl: API_URL,
      cwd,
    })

    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toContain("Command:     npx")
    expect(result.message).toContain('Args:        ["-y","@lyrashield/mcp"]')
  })

  it("claude-code merge-safety keeps foreign servers and unrelated keys", async () => {
    await ignoreSharedConfig(cwd)
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
    await ignoreSharedConfig(cwd)
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
    await ignoreSharedConfig(cwd)
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

  it("OAuth device credentials write a local config without an expiring bearer token", async () => {
    const result = await installAgent({
      agent: claude,
      transport: "stdio",
      apiUrl: API_URL,
      scope: "project",
      cwd,
      all: true,
      useCredentialStore: true,
    })

    expect(result.outcome).toBe("CONFIGURED")
    const content = await readFile(path.join(cwd, ".mcp.json"), "utf-8")
    expect(content).toContain("LYRASHIELD_API_URL")
    expect(content).not.toContain("LYRASHIELD_API_KEY")
    expect(content).not.toContain("oauth")
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
    await ignoreSharedConfig(cwd)
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

  it("inline-secret refuses a new unignored shared config", async () => {
    execFileSync("git", ["init", "-q"], { cwd })

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

    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toMatch(/not ignored/i)
    await expect(readFile(path.join(cwd, ".mcp.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("toml merge-safety keeps foreign servers and unrelated keys", async () => {
    const fixture = `unrelated = true

[mcp_servers.acme]
command = "npx"
args = ["acme-mcp"]`
    const filePath = path.join(cwd, "config.toml")
    await writeFile(filePath, fixture, "utf-8")

    const result = await mergeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
      value: {
        command: "npx",
        args: ["-y", "@lyrashield/mcp"],
        env: {
          LYRASHIELD_API_KEY: API_KEY,
          LYRASHIELD_API_URL: API_URL,
        },
      },
    })

    expect(result.changed).toBe(true)

    const content = await readFile(filePath, "utf-8")
    const parsed = TOML.parse(content) as Record<string, unknown>
    expect(parsed).toHaveProperty("unrelated", true)
    expect(parsed).toHaveProperty("mcp_servers")
    const servers = parsed["mcp_servers"] as Record<string, unknown>
    expect(servers).toHaveProperty("acme")
    expect(servers).toHaveProperty("lyrashield")
    const acme = servers["acme"] as Record<string, unknown>
    expect(acme).toHaveProperty("command", "npx")
    expect(acme).toHaveProperty("args", ["acme-mcp"])
    const lyra = servers["lyrashield"] as Record<string, unknown>
    expect(lyra).toHaveProperty("command", "npx")
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp"])
    expect(lyra).toHaveProperty("env")
    const env = lyra["env"] as Record<string, unknown>
    expect(env).toEqual({
      LYRASHIELD_API_KEY: API_KEY,
      LYRASHIELD_API_URL: API_URL,
    })
  })

  it("yaml merge-safety keeps foreign servers and unrelated keys", async () => {
    const fixture = `unrelated: true
mcp_servers:
  acme:
    command: npx
    args: [acme-mcp]`
    const filePath = path.join(cwd, "config.yaml")
    await writeFile(filePath, fixture, "utf-8")

    const result = await mergeFile({
      filePath,
      format: "yaml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
      value: {
        command: "npx",
        args: ["-y", "@lyrashield/mcp"],
      },
    })

    expect(result.changed).toBe(true)

    const content = await readFile(filePath, "utf-8")
    const parsed = YAML.parse(content) as Record<string, unknown>
    expect(parsed).toHaveProperty("unrelated", true)
    expect(parsed).toHaveProperty("mcp_servers")
    const servers = parsed["mcp_servers"] as Record<string, unknown>
    expect(servers).toHaveProperty("acme")
    expect(servers).toHaveProperty("lyrashield")
    const acme = servers["acme"] as Record<string, unknown>
    expect(acme).toHaveProperty("command", "npx")
    expect(acme).toHaveProperty("args", ["acme-mcp"])
    const lyra = servers["lyrashield"] as Record<string, unknown>
    expect(lyra).toHaveProperty("command", "npx")
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp"])
  })
})
