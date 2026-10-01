import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { getAgent } from "@lyrashield/agent-registry"
import { installAgent, uninstallAgent } from "../../installers/install.js"
import { mergeFile, removeFile } from "../../installers/merge.js"
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
const opencode = getAgent("opencode")!
const devin = getAgent("devin")!

describe("conformance: install/uninstall round-trips", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await tempDir()
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it("does not invent native MCP configuration for unsupported guided clients", async () => {
    const result = await installAgent({
      agent: aider,
      transport: "stdio",
      apiUrl: API_URL,
      cwd,
    })

    expect(result.outcome).toBe("MANUAL_REQUIRED")
    expect(result.message).toContain("does not document native MCP client support")
    expect(result.message).not.toContain("Command:     npx")
  })

  it.each([API_URL, `${API_URL}/api`, `${API_URL}/api/v1`, `${API_URL}/api/mcp`])(
    "normalizes the guided remote endpoint from %s",
    async (apiUrl) => {
      const result = await installAgent({
        agent: devin,
        transport: "remote-http",
        apiUrl,
        cwd,
      })

      expect(result.outcome).toBe("MANUAL_REQUIRED")
      expect(result.message).toContain(`URL:            ${API_URL}/api/mcp`)
      expect(result.message).toContain("Authentication: OAuth")
      expect(result.message).not.toContain("Bearer API key")
    }
  )

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
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp@0.2.11"])
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
    expect(content).not.toContain("LYRASHIELD_API_URL")
    expect(content).not.toContain("LYRASHIELD_API_KEY")
    expect(content).not.toContain("oauth")
  })

  it("native remote OAuth writes server metadata without a bearer token", async () => {
    const result = await installAgent({
      agent: opencode,
      transport: "remote-http",
      apiUrl: API_URL,
      scope: "project",
      cwd,
      all: true,
    })

    expect(result.outcome).toBe("CONFIGURED")
    const content = await readFile(path.join(cwd, "opencode.json"), "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>
    expect(mcp.lyrashield).toMatchObject({
      type: "remote",
      url: "https://app.lyrashieldai.com/api/mcp",
    })
    expect(content).not.toContain("Authorization")
    expect(content).not.toContain("LYRASHIELD_API_KEY")
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
        args: ["-y", "@lyrashield/mcp@0.2.11"],
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
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp@0.2.11"])
    expect(lyra).toHaveProperty("env")
    const env = lyra["env"] as Record<string, unknown>
    expect(env).toEqual({
      LYRASHIELD_API_KEY: API_KEY,
      LYRASHIELD_API_URL: API_URL,
    })
  })

  it("TOML merge ignores table-looking text inside multiline strings", async () => {
    const filePath = path.join(cwd, "multiline-string-merge.toml")
    const content = `message = """A table-like string follows
[mcp_servers.lyrashield]
command = "not a table"
"""

[mcp_servers.lyrashield]
details = """A table-like string follows
[mcp_servers.acme]
command = "not a table"
"""
command = "old"

[mcp_servers.acme]
command = "acme-mcp"
`
    await writeFile(filePath, content, "utf-8")

    await mergeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
      value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
    })

    const result = await readFile(filePath, "utf-8")
    const parsed = TOML.parse(result) as {
      message: string
      mcp_servers: Record<string, unknown>
    }
    expect(parsed.message).toBe(
      'A table-like string follows\n[mcp_servers.lyrashield]\ncommand = "not a table"\n'
    )
    expect(parsed.mcp_servers).toMatchObject({
      acme: { command: "acme-mcp" },
      lyrashield: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
    })
  })

  it("refuses to replace an inline existing TOML target without modifying it", async () => {
    const filePath = path.join(cwd, "inline-target.toml")
    const content = `mcp_servers = { lyrashield = { command = "npx", args = ["old"] }, acme = { command = "acme-mcp" } }\n`
    await writeFile(filePath, content, "utf-8")

    await expect(
      mergeFile({
        filePath,
        format: "toml",
        rootKey: "mcp_servers",
        serverName: "lyrashield",
        value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
      })
    ).rejects.toThrow(/inline TOML entry/i)

    expect(await readFile(filePath, "utf-8")).toBe(content)
    expect(await readdir(cwd)).toEqual(["inline-target.toml"])
  })

  it("preserves comments and spacing before the next TOML table on merge and removal", async () => {
    const filePath = path.join(cwd, "trailing-comments.toml")
    const content = `[mcp_servers.lyrashield]
command = "old"

# Keep this note with Acme.
# Owned by Platform.

[mcp_servers.acme]
command = "acme-mcp"
`
    await writeFile(filePath, content, "utf-8")

    await mergeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
      value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
    })
    const merged = await readFile(filePath, "utf-8")
    const preservedBlock = "# Keep this note with Acme.\n# Owned by Platform.\n\n[mcp_servers.acme]"
    expect(merged).toContain(preservedBlock)

    await removeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
    })
    const removed = await readFile(filePath, "utf-8")
    expect(removed).toContain(preservedBlock)
    expect(TOML.parse(removed)).toMatchObject({ mcp_servers: { acme: { command: "acme-mcp" } } })
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
        args: ["-y", "@lyrashield/mcp@0.2.11"],
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
    expect(lyra).toHaveProperty("args", ["-y", "@lyrashield/mcp@0.2.11"])
  })

  it.each([
    {
      format: "json",
      rootKey: "mcpServers",
      content: '{"mcpServers": null}\n',
      extension: "json",
    },
    {
      format: "jsonc",
      rootKey: "mcp",
      content: '{\n  // user-owned value\n  "mcp": null\n}\n',
      extension: "jsonc",
    },
    {
      format: "toml",
      rootKey: "mcp_servers",
      content: 'mcp_servers = "user-owned value"\n',
      extension: "toml",
    },
    {
      format: "toml",
      rootKey: "mcp_servers",
      content: 'mcp_servers = { acme = { command = "acme-mcp" } }\n',
      extension: "toml-inline",
    },
    {
      format: "yaml",
      rootKey: "mcp_servers",
      content: "mcp_servers: null\n",
      extension: "yaml",
    },
  ] as const)(
    "refuses to replace a non-table $format root",
    async ({ format, rootKey, content, extension }) => {
      const filePath = path.join(cwd, `occupied-root.${extension}`)
      await writeFile(filePath, content, "utf-8")

      await expect(
        mergeFile({
          filePath,
          format,
          rootKey,
          serverName: "lyrashield",
          value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
        })
      ).rejects.toThrow()

      expect(await readFile(filePath, "utf-8")).toBe(content)
      expect(await readdir(cwd)).toEqual([`occupied-root.${extension}`])
    }
  )

  it("does not create a backup or modify a target when a config path is a symlink", async () => {
    const target = path.join(cwd, "shared-config.json")
    const linkPath = path.join(cwd, "client-config.json")
    const original = '{"mcpServers":{"acme":{"command":"acme-mcp"}}}\n'
    await writeFile(target, original, "utf-8")
    await symlink(target, linkPath)

    await expect(
      mergeFile({
        filePath: linkPath,
        format: "json",
        rootKey: "mcpServers",
        serverName: "lyrashield",
        value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
      })
    ).rejects.toThrow(/symlink/i)

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    expect(await readlink(linkPath)).toBe(target)
    expect(await readFile(target, "utf-8")).toBe(original)
    expect((await readdir(cwd)).sort()).toEqual(["client-config.json", "shared-config.json"])
  })

  it("preserves restrictive permissions on config edits and their backups", async () => {
    const filePath = path.join(cwd, "private-config.json")
    await writeFile(filePath, '{"unrelated":true}\n', { encoding: "utf-8", mode: 0o600 })

    const result = await mergeFile({
      filePath,
      format: "json",
      rootKey: "mcpServers",
      serverName: "lyrashield",
      value: { command: "npx", args: ["-y", "@lyrashield/mcp@0.2.11"] },
    })

    expect(result.backupPath).toBeDefined()
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect((await stat(result.backupPath!)).mode & 0o777).toBe(0o600)
  })

  it.each([
    {
      format: "json",
      rootKey: "mcpServers",
      content: '{"mcpServers":{"lyrashield":{"command":"npx"}},"broken": }\n',
      extension: "json",
    },
    {
      format: "jsonc",
      rootKey: "mcp",
      content: '{\n  "mcp": { "lyrashield": { "command": "npx" } },\n  "broken": }\n',
      extension: "jsonc",
    },
    {
      format: "toml",
      rootKey: "mcp_servers",
      content: '[mcp_servers.lyrashield]\ncommand = "npx"\nbroken =\n',
      extension: "toml",
    },
    {
      format: "yaml",
      rootKey: "mcp_servers",
      content: "mcp_servers:\n  lyrashield:\n    command: npx\n  broken: [unterminated\n",
      extension: "yaml",
    },
  ] as const)(
    "refuses to remove from malformed $format config without a backup",
    async ({ format, rootKey, content, extension }) => {
      const filePath = path.join(cwd, `malformed.${extension}`)
      await writeFile(filePath, content, "utf-8")

      await expect(
        removeFile({ filePath, format, rootKey, serverName: "lyrashield" })
      ).rejects.toThrow()

      expect(await readFile(filePath, "utf-8")).toBe(content)
      expect(await readdir(cwd)).toEqual([`malformed.${extension}`])
    }
  )

  it.each([
    { format: "json", rootKey: "mcpServers", content: '{"mcpServers":null}\n' },
    { format: "jsonc", rootKey: "mcp", content: '{ "mcp": null }\n' },
    { format: "toml", rootKey: "mcp_servers", content: 'mcp_servers = "occupied"\n' },
    { format: "yaml", rootKey: "mcp_servers", content: "mcp_servers: null\n" },
  ] as const)(
    "refuses to remove from a non-object $format root without a backup",
    async ({ format, rootKey, content }) => {
      const filePath = path.join(cwd, `wrong-root.${format}`)
      await writeFile(filePath, content, "utf-8")

      await expect(
        removeFile({ filePath, format, rootKey, serverName: "lyrashield" })
      ).rejects.toThrow()

      expect(await readFile(filePath, "utf-8")).toBe(content)
      expect(await readdir(cwd)).toEqual([`wrong-root.${format}`])
    }
  )

  it("does not treat a TOML comment as an installed section during removal", async () => {
    const filePath = path.join(cwd, "commented-section.toml")
    const content = `# User note
# [mcp_servers.lyrashield]
unrelated = "keep this value"

[mcp_servers.acme]
command = "acme-mcp"
`
    await writeFile(filePath, content, "utf-8")

    const removed = await removeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
    })

    expect(removed).toBe(false)
    expect(await readFile(filePath, "utf-8")).toBe(content)
    expect(await readdir(cwd)).toEqual(["commented-section.toml"])
  })

  it("skips TOML table-looking lines inside multiline strings during removal", async () => {
    const filePath = path.join(cwd, "multiline-string-section.toml")
    const content = `message = """A table-like string follows
[mcp_servers.lyrashield]
command = "not a table"
"""

[mcp_servers.lyrashield]
command = "npx"

[mcp_servers.acme]
command = "acme-mcp"
`
    await writeFile(filePath, content, "utf-8")

    const removed = await removeFile({
      filePath,
      format: "toml",
      rootKey: "mcp_servers",
      serverName: "lyrashield",
    })

    expect(removed).toBe(true)
    const result = await readFile(filePath, "utf-8")
    expect(result).toContain('message = """A table-like string follows\n[mcp_servers.lyrashield]')
    expect(result).toContain('[mcp_servers.acme]\ncommand = "acme-mcp"')
    const parsed = TOML.parse(result) as { mcp_servers?: Record<string, unknown> }
    expect(parsed).toMatchObject({
      message: 'A table-like string follows\n[mcp_servers.lyrashield]\ncommand = "not a table"\n',
      mcp_servers: { acme: { command: "acme-mcp" } },
    })
    expect(parsed.mcp_servers).not.toHaveProperty("lyrashield")
    expect((await readdir(cwd)).sort()).toHaveLength(2)
    const backupName = (await readdir(cwd)).find((entry) => entry.includes("lyrashield-backup"))
    expect(backupName).toBeDefined()
    expect(await readFile(path.join(cwd, backupName!), "utf-8")).toBe(content)
  })
})
