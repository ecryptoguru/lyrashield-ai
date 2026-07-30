import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { redactKey, createOutput, isTTY } from "../output.js"
import { resolveSecretMode } from "../installers/secret-mode.js"
import { mergeJson } from "../installers/json.js"
import { mergeFile, removeFile } from "../installers/merge.js"
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"

describe("output", () => {
  it("redacts an lsk key to last 4", () => {
    const key = "lsk_abcdef1234567890abcdef1234567890abcdef12"
    expect(redactKey(key)).toBe(`lsk_${key.slice(-4)}`)
  })

  it("marks a missing key as not set", () => {
    expect(redactKey(undefined)).toBe("not set")
  })

  it("marks non-lyrashield keys", () => {
    expect(redactKey("sk-123456")).toBe("non-LyraShield key")
  })
})

describe("secret mode", () => {
  it("interpolates for opencode", async () => {
    const loc: ConfigLocation = {
      scope: "project",
      path: "opencode.json",
      sharedByConvention: true,
    }
    const agent: AgentEntry = {
      id: "opencode",
      displayName: "OpenCode",
      docsSlug: "opencode",
      installStrategy: "config-file",
      format: "json",
      rootKey: "mcp",
      locations: [loc],
      transports: ["stdio"],
      credential: { kind: "interpolated-env", syntax: "{env:LYRASHIELD_API_KEY}" },
      rulesFiles: [],
      gotchas: [],
    }
    const res = await resolveSecretMode({
      agent,
      location: loc,
      transport: "stdio",
      apiKey: "lsk_test",
      apiUrl: "https://app.lyrashieldai.com",
      inlineSecret: false,
    })
    expect(res.mode).toBe("interpolated")
  })

  it("refuses to inline a shared file without the flag", async () => {
    const loc: ConfigLocation = {
      scope: "project",
      path: ".cursor/mcp.json",
      sharedByConvention: true,
    }
    const agent: AgentEntry = {
      id: "cursor",
      displayName: "Cursor",
      docsSlug: "cursor",
      installStrategy: "config-file",
      format: "json",
      rootKey: "mcpServers",
      locations: [loc],
      transports: ["stdio"],
      credential: { kind: "inline-env" },
      rulesFiles: [],
      gotchas: [],
    }
    const res = await resolveSecretMode({
      agent,
      location: loc,
      transport: "stdio",
      apiKey: "lsk_test",
      apiUrl: "https://app.lyrashieldai.com",
      inlineSecret: false,
    })
    expect(res.mode).toBe("manual")
  })
})

describe("json merge", () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lyrashield-cli-"))
  })
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("writes and verifies a new file atomically", async () => {
    const file = path.join(tmp, "mcp.json")
    const result = await mergeJson({
      filePath: file,
      rootKey: "mcpServers",
      serverName: "lyrashield",
      value: { command: "npx", args: ["-y", "@lyrashield/mcp"] },
    })
    expect(result.changed).toBe(true)
    const raw = await readFile(file, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).lyrashield).toEqual({
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
    })
  })

  it("is idempotent", async () => {
    const file = path.join(tmp, "idempotent.json")
    const value = { command: "npx", args: ["-y", "@lyrashield/mcp"] }
    await mergeJson({ filePath: file, rootKey: "mcpServers", serverName: "lyrashield", value })
    const second = await mergeJson({
      filePath: file,
      rootKey: "mcpServers",
      serverName: "lyrashield",
      value,
    })
    expect(second.changed).toBe(false)
  })

  it("does not write in dry run", async () => {
    const file = path.join(tmp, "dryrun.json")
    const result = await mergeFile({
      filePath: file,
      format: "json",
      rootKey: "mcpServers",
      serverName: "lyrashield",
      value: { command: "npx" },
      dryRun: true,
    })
    expect(result.changed).toBe(true)
    await expect(access(file)).rejects.toBeDefined()
  })

  it("preserves a foreign server on merge", async () => {
    const file = path.join(tmp, "foreign.json")
    const initial = {
      mcpServers: {
        other: { command: "node", args: ["other.js"] },
      },
    }
    await writeFile(file, JSON.stringify(initial, null, 2) + "\n", "utf-8")
    await mergeJson({
      filePath: file,
      rootKey: "mcpServers",
      serverName: "lyrashield",
      value: { command: "npx" },
    })
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).other).toEqual({
      command: "node",
      args: ["other.js"],
    })
    expect((parsed.mcpServers as Record<string, unknown>).lyrashield).toEqual({ command: "npx" })
  })

  it("removes only the lyrashield entry", async () => {
    const file = path.join(tmp, "remove.json")
    const initial = {
      mcpServers: {
        other: { command: "node" },
        lyrashield: { command: "npx" },
      },
    }
    await writeFile(file, JSON.stringify(initial, null, 2) + "\n", "utf-8")
    const removed = await removeFile({
      filePath: file,
      format: "json",
      rootKey: "mcpServers",
      serverName: "lyrashield",
    })
    expect(removed).toBe(true)
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>
    expect((parsed.mcpServers as Record<string, unknown>).lyrashield).toBeUndefined()
    expect((parsed.mcpServers as Record<string, unknown>).other).toEqual({ command: "node" })
  })
})
