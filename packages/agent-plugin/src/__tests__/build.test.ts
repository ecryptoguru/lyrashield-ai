import { describe, expect, it } from "vitest"
import { buildPlugin } from "../build.js"
import { getPluginDir } from "../index.js"
import { validatePlugin } from "../validate.js"
import { access, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { MCP_TOOL_ANNOTATIONS } from "@lyrashield/mcp"

describe("buildPlugin", () => {
  it("publishes without unpublished workspace dependencies", async () => {
    const pluginRoot = getPluginDir()
    const packageJson = JSON.parse(
      await readFile(path.resolve(pluginRoot, "..", "package.json"), "utf-8")
    ) as { dependencies: Record<string, string> }

    expect(
      Object.keys(packageJson.dependencies).filter((name) => name.startsWith("@lyrashield/"))
    ).toEqual([])
  })

  it("generates SKILL.md and client shims", async () => {
    await buildPlugin()
    const pluginRoot = getPluginDir()

    const skill = path.join(pluginRoot, "skills", "lyrashield", "SKILL.md")
    await access(skill)

    const skillContent = await readFile(skill, "utf-8")
    expect(skillContent).toContain("name: lyrashield")
    expect(skillContent).toContain("## Review-depth guide")
    expect(skillContent).toContain("## Example prompts and tool calls")
    expect(skillContent).toContain("## Depth and runtime awareness")
    expect(skillContent).toContain(
      '| "Repository pentest" / "Deep security scan" | FULL_PENTEST | DEEP |'
    )
    expect(skillContent).toContain("Do not run scans against third-party URLs or repositories")
    expect(skillContent).toContain("poll the returned retest scan to a terminal state")
    expect(skillContent).toContain("outcome and scan reference")
    expect(skillContent).toContain("separate independent-verification receipt")

    const expectedSkills = [
      "lyrashield",
      "get-started",
      "review-changes",
      "scan-project",
      "fix-and-retest",
      "launch-readiness",
    ]
    const declaredTools = new Set(Object.keys(MCP_TOOL_ANNOTATIONS))
    const skillDirectories = await readdir(path.join(pluginRoot, "skills"), {
      withFileTypes: true,
    })
    expect(
      skillDirectories
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    ).toEqual([...expectedSkills].sort())
    for (const skillName of expectedSkills) {
      const content = await readFile(
        path.join(pluginRoot, "skills", skillName, "SKILL.md"),
        "utf-8"
      )
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)
      expect(frontmatter, `${skillName} must have YAML frontmatter`).not.toBeNull()
      expect(frontmatter?.[1]?.split(/\r?\n/)).toContain(`name: ${skillName}`)
      expect(frontmatter?.[1]).toMatch(/^description: .+$/m)
      for (const [, toolName] of content.matchAll(/\b(lyrashield_[a-z_]+)\b/g)) {
        expect(declaredTools.has(toolName!), `${skillName} references ${toolName}`).toBe(true)
      }
      await expect(
        readFile(path.join(pluginRoot, "codex-plugin", "skills", skillName, "SKILL.md"), "utf-8")
      ).resolves.toBe(content)
      expect(content).not.toMatch(/\blsk_[A-Za-z0-9]{24,}\b/)
    }

    const portableMcp = JSON.parse(await readFile(path.join(pluginRoot, "mcp.json"), "utf-8")) as {
      $schema?: string
      mcpServers?: Record<string, { type?: string; url?: string }>
    }
    expect(portableMcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json")
    expect(portableMcp.mcpServers?.lyrashield).toEqual({
      type: "streamable-http",
      url: "https://app.lyrashieldai.com/api/mcp",
    })
    await expect(validatePlugin(pluginRoot)).resolves.toEqual({ ok: true, errors: [] })

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

    const codexManifest = JSON.parse(
      await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf-8")
    )
    expect(codexManifest.mcpServers).toBe("./.mcp.codex.json")
    expect(JSON.parse(await readFile(path.join(pluginRoot, ".mcp.codex.json"), "utf-8"))).toEqual({
      lyrashield: { url: "https://app.lyrashieldai.com/api/mcp" },
    })
    expect(
      JSON.parse(await readFile(path.join(pluginRoot, "codex-plugin", ".mcp.json"), "utf-8"))
    ).toEqual({
      lyrashield: {
        type: "streamable-http",
        url: "https://app.lyrashieldai.com/api/mcp",
      },
    })
    const codexMarketplace = JSON.parse(
      await readFile(path.join(pluginRoot, ".agents", "plugins", "marketplace.json"), "utf-8")
    )
    expect(codexMarketplace.plugins[0]).toMatchObject({
      name: "lyrashield",
      source: { source: "local", path: "./codex-plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    })

    // Marketplace catalog: makes the exported repo addressable for `/plugin marketplace add`
    // and VS Code's "Install Plugin From Source". `source: "./"` resolves to the marketplace
    // root — the directory holding `.claude-plugin/` — which is where plugin.json lives.
    const marketplacePath = path.join(pluginRoot, ".claude-plugin", "marketplace.json")
    await access(marketplacePath)
    const marketplaceRaw = await readFile(marketplacePath, "utf-8")
    expect(marketplaceRaw.endsWith("\n")).toBe(true)
    const marketplace = JSON.parse(marketplaceRaw)
    expect(marketplace.name).toBe("lyrashield-ai")
    expect(marketplace.owner.name).toBe("LyraShield AI")
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins[0].name).toBe("lyrashield")
    expect(marketplace.plugins[0].source).toBe("./")
    // Catalog version must track the plugin manifest so installs aren't pinned to a stale build.
    const pluginManifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf-8"))
    expect(marketplace.version).toBe(pluginManifest.version)
    expect(marketplace.plugins[0].version).toBe(pluginManifest.version)
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
