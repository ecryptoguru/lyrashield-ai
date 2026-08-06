import { describe, expect, it } from "vitest"
import { buildPlugin } from "../build.js"
import { getPluginDir } from "../index.js"
import { access, readFile } from "node:fs/promises"
import path from "node:path"

describe("buildPlugin", () => {
  it("generates SKILL.md and client shims", async () => {
    await buildPlugin()
    const pluginRoot = getPluginDir()

    const skill = path.join(pluginRoot, "skills", "lyrashield", "SKILL.md")
    await access(skill)

    const skillContent = await readFile(skill, "utf-8")
    expect(skillContent).toContain("name: lyrashield")
    expect(skillContent).toContain("## Pre-PR check")

    for (const client of ["claude", "cursor", "codex", "kiro"]) {
      const shim = path.join(pluginRoot, `.${client}-plugin`, "plugin.json")
      await access(shim)
      const content = await readFile(shim, "utf-8")
      expect(JSON.parse(content).name).toBe("lyrashield")
    }
  })
})
