/* eslint-disable security/detect-non-literal-fs-filename */
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
    expect(skillContent).toContain("## Mode and cost guide")
    expect(skillContent).toContain("## Example prompts and tool calls")
    expect(skillContent).toContain("## Cost and minute awareness")

    // The appendix must not duplicate sections already emitted by LYRASHIELD_POLICY.
    for (const heading of ["## Pre-PR check", "## Post-fix verification", "## Honesty clause"]) {
      const first = skillContent.indexOf(heading)
      expect(first, `missing ${heading}`).toBeGreaterThan(-1)
      expect(skillContent.lastIndexOf(heading), `duplicate ${heading}`).toBe(first)
    }

    for (const client of ["claude", "cursor", "codex", "kiro"]) {
      const shim = path.join(pluginRoot, `.${client}-plugin`, "plugin.json")
      await access(shim)
      const content = await readFile(shim, "utf-8")
      expect(JSON.parse(content).name).toBe("lyrashield")
      expect(content.endsWith("\n")).toBe(true)
      if (client === "codex") expect(JSON.parse(content).skills).toBe("./skills/")
    }
  })

  it("leaves every generated manifest valid during concurrent builds", async () => {
    await Promise.all(Array.from({ length: 4 }, () => buildPlugin()))
    const pluginRoot = getPluginDir()

    for (const client of ["claude", "cursor", "codex", "kiro"]) {
      const shim = path.join(pluginRoot, `.${client}-plugin`, "plugin.json")
      const content = await readFile(shim, "utf-8")
      expect(() => JSON.parse(content)).not.toThrow()
    }
  })
})
