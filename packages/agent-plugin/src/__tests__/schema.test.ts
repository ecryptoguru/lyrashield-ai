import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { validatePlugin } from "../validate.js"
import { getPluginDir } from "../index.js"

describe("validatePlugin", () => {
  it("validates the built-in plugin directory", async () => {
    const result = await validatePlugin(getPluginDir())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects the vendor-specific "http" value in portable Agent Plugins MCP config', async () => {
    const source = getPluginDir()
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-schema-"))
    try {
      await writeFile(
        path.join(temporaryRoot, "plugin.json"),
        await readFile(path.join(source, "plugin.json"), "utf-8")
      )
      const mcp = JSON.parse(await readFile(path.join(source, "mcp.json"), "utf-8")) as {
        mcpServers: Record<string, { type: string }>
      }
      mcp.mcpServers.lyrashield!.type = "http"
      await writeFile(path.join(temporaryRoot, "mcp.json"), JSON.stringify(mcp))

      const result = await validatePlugin(temporaryRoot)
      expect(result.ok).toBe(false)
      expect(result.errors.some((error) => error.startsWith("mcp.json:"))).toBe(true)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it("rejects invalid skill metadata and credential-like keys", async () => {
    const source = getPluginDir()
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-skills-"))
    try {
      await cp(path.join(source, "plugin.json"), path.join(temporaryRoot, "plugin.json"))
      await cp(path.join(source, "mcp.json"), path.join(temporaryRoot, "mcp.json"))
      await cp(path.join(source, "skills"), path.join(temporaryRoot, "skills"), {
        recursive: true,
      })
      const skill = path.join(temporaryRoot, "skills", "get-started", "SKILL.md")
      await writeFile(
        skill,
        "---\nname: wrong-name\ndescription: broken\n---\nExample: lsk_" + "A".repeat(24)
      )

      const result = await validatePlugin(temporaryRoot)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain(
        "get-started/SKILL.md frontmatter name must match its directory"
      )
      expect(result.errors).toContain(
        "Credential-like LyraShield key detected in skills/get-started/SKILL.md"
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it("rejects symlinked component directories", async () => {
    const source = getPluginDir()
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-symlink-"))
    try {
      await cp(path.join(source, "plugin.json"), path.join(temporaryRoot, "plugin.json"))
      await cp(path.join(source, "mcp.json"), path.join(temporaryRoot, "mcp.json"))
      await mkdir(path.join(temporaryRoot, "skills"))
      await cp(
        path.join(source, "skills", "get-started"),
        path.join(temporaryRoot, "outside-skill"),
        { recursive: true }
      )
      await symlink(
        path.join(temporaryRoot, "outside-skill"),
        path.join(temporaryRoot, "skills", "linked")
      )

      const result = await validatePlugin(temporaryRoot)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain("Unsupported entry in skills/: linked")
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it("rejects unsafe skill directory names", async () => {
    const source = getPluginDir()
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-name-"))
    try {
      await cp(path.join(source, "plugin.json"), path.join(temporaryRoot, "plugin.json"))
      await cp(path.join(source, "mcp.json"), path.join(temporaryRoot, "mcp.json"))
      await cp(
        path.join(source, "skills", "get-started"),
        path.join(temporaryRoot, "skills", "-bad"),
        {
          recursive: true,
        }
      )

      const result = await validatePlugin(temporaryRoot)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain("Invalid skill directory name: -bad")
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
