import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ConfigFormat } from "@lyrashield/agent-registry"

const race = vi.hoisted(() => ({ replacement: null as string | null }))

vi.mock("../../installers/backup.js", async () => {
  const { writeFile: writeFileForRace } = await import("node:fs/promises")
  return {
    backupFile: async (filePath: string) => {
      if (race.replacement !== null) {
        await writeFileForRace(filePath, race.replacement, "utf-8")
        race.replacement = null
      }
      return undefined
    },
  }
})

import { mergeFile, removeFile } from "../../installers/merge.js"

const formats: Array<{
  format: ConfigFormat
  extension: string
  mergeOriginal: string
  mergeConcurrent: string
  removeOriginal: string
  removeConcurrent: string
}> = [
  {
    format: "json",
    extension: "json",
    mergeOriginal: '{"mcpServers":{"acme":{"command":"acme-mcp"}}}\n',
    mergeConcurrent: '{"mcpServers":{"acme":{"command":"acme-mcp"}},"concurrent":{"keep":true}}\n',
    removeOriginal:
      '{"mcpServers":{"lyrashield":{"command":"old"},"acme":{"command":"acme-mcp"}}}\n',
    removeConcurrent:
      '{"mcpServers":{"lyrashield":{"command":"old"},"acme":{"command":"acme-mcp"}},"concurrent":{"keep":true}}\n',
  },
  {
    format: "jsonc",
    extension: "jsonc",
    mergeOriginal: '{\n  "mcp": { "acme": { "command": "acme-mcp" } }\n}\n',
    mergeConcurrent:
      '{\n  "mcp": { "acme": { "command": "acme-mcp" } },\n  "concurrent": { "keep": true }\n}\n',
    removeOriginal:
      '{\n  "mcp": { "lyrashield": { "command": "old" }, "acme": { "command": "acme-mcp" } }\n}\n',
    removeConcurrent:
      '{\n  "mcp": { "lyrashield": { "command": "old" }, "acme": { "command": "acme-mcp" } },\n  "concurrent": { "keep": true }\n}\n',
  },
  {
    format: "toml",
    extension: "toml",
    mergeOriginal: '[mcp_servers.acme]\ncommand = "acme-mcp"\n',
    mergeConcurrent: 'concurrent = "keep"\n\n[mcp_servers.acme]\ncommand = "acme-mcp"\n',
    removeOriginal:
      'concurrent = "keep"\n\n[mcp_servers.lyrashield]\ncommand = "old"\n\n[mcp_servers.acme]\ncommand = "acme-mcp"\n',
    removeConcurrent:
      'concurrent = "updated"\n\n[mcp_servers.lyrashield]\ncommand = "old"\n\n[mcp_servers.acme]\ncommand = "acme-mcp"\n',
  },
  {
    format: "yaml",
    extension: "yaml",
    mergeOriginal: "mcp_servers:\n  acme:\n    command: acme-mcp\n",
    mergeConcurrent: "mcp_servers:\n  acme:\n    command: acme-mcp\nconcurrent:\n  keep: true\n",
    removeOriginal:
      "mcp_servers:\n  lyrashield:\n    command: old\n  acme:\n    command: acme-mcp\n",
    removeConcurrent:
      "mcp_servers:\n  lyrashield:\n    command: old\n  acme:\n    command: acme-mcp\nconcurrent:\n  keep: true\n",
  },
]

function rootKeyFor(format: ConfigFormat): string {
  if (format === "json") return "mcpServers"
  if (format === "jsonc") return "mcp"
  return "mcp_servers"
}

describe("concurrent config writes", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "lyrashield-concurrent-config-"))
    race.replacement = null
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
    race.replacement = null
  })

  it.each(formats)("preserves concurrent edits during $format merge", async (fixture) => {
    const filePath = path.join(cwd, `config.${fixture.extension}`)
    await writeFile(filePath, fixture.mergeOriginal, "utf-8")
    race.replacement = fixture.mergeConcurrent

    await expect(
      mergeFile({
        filePath,
        format: fixture.format,
        rootKey: rootKeyFor(fixture.format),
        serverName: "lyrashield",
        value: { command: "npx", args: ["-y", "@lyrashield/mcp"] },
      })
    ).rejects.toThrow(/contents changed/i)

    expect(await readFile(filePath, "utf-8")).toBe(fixture.mergeConcurrent)
  })

  it.each(formats)("preserves concurrent edits during $format removal", async (fixture) => {
    const filePath = path.join(cwd, `config.${fixture.extension}`)
    await writeFile(filePath, fixture.removeOriginal, "utf-8")
    race.replacement = fixture.removeConcurrent

    await expect(
      removeFile({
        filePath,
        format: fixture.format,
        rootKey: rootKeyFor(fixture.format),
        serverName: "lyrashield",
      })
    ).rejects.toThrow(/contents changed/i)

    expect(await readFile(filePath, "utf-8")).toBe(fixture.removeConcurrent)
  })

  it.each(formats)("rejects a concurrent creation during $format merge", async (fixture) => {
    const filePath = path.join(cwd, `new-config.${fixture.extension}`)
    race.replacement = fixture.mergeConcurrent

    await expect(
      mergeFile({
        filePath,
        format: fixture.format,
        rootKey: rootKeyFor(fixture.format),
        serverName: "lyrashield",
        value: { command: "npx", args: ["-y", "@lyrashield/mcp"] },
      })
    ).rejects.toThrow(/contents changed/i)

    expect(await readFile(filePath, "utf-8")).toBe(fixture.mergeConcurrent)
  })
})
