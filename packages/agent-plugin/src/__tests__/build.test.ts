import { describe, expect, it, onTestFinished } from "vitest"
import { buildPlugin } from "../build.js"
import { getPluginDir } from "../index.js"
import { validatePlugin } from "../validate.js"
import { access, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MCP_TOOL_ANNOTATIONS } from "@lyrashield/mcp"

async function createIsolatedPluginRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-test-"))
  const pluginRoot = path.join(temporaryRoot, "plugin")
  onTestFinished(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })
  await cp(getPluginDir(), pluginRoot, {
    recursive: true,
    filter: (source) => !source.endsWith(".tmp"),
  })
  return pluginRoot
}

async function createIsolatedPackagedPluginRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-plugin-package-test-"))
  const pluginRoot = path.join(temporaryRoot, "packages", "agent-plugin", "plugin")
  onTestFinished(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })
  await cp(getPluginDir(), pluginRoot, {
    recursive: true,
    filter: (source) => !source.endsWith(".tmp"),
  })
  return pluginRoot
}

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

  it("uses the bundled icon when the canonical docs asset is absent from a package tree", async () => {
    const pluginRoot = await createIsolatedPackagedPluginRoot()
    const docsAssetPath = path.resolve(
      pluginRoot,
      "../../../docs/marketplace/assets/lyrashield-400.png"
    )
    await expect(access(docsAssetPath)).rejects.toMatchObject({ code: "ENOENT" })

    const bundledIconPath = path.join(pluginRoot, "assets", "lyrashield-400.png")
    const bundledIconBefore = await readFile(bundledIconPath)
    await buildPlugin({ pluginRoot })

    await expect(readFile(bundledIconPath)).resolves.toEqual(bundledIconBefore)
    await expect(validatePlugin(pluginRoot)).resolves.toEqual({ ok: true, errors: [] })
  })

  it("does not hide an explicit logo asset error with the bundled icon", async () => {
    const pluginRoot = await createIsolatedPluginRoot()
    const missingLogoAssetPath = path.join(pluginRoot, "missing-logo.png")

    await expect(
      buildPlugin({ pluginRoot, logoAssetPath: missingLogoAssetPath })
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("generates SKILL.md and client shims", async () => {
    const sourcePluginRoot = getPluginDir()
    const sourceManifestBefore = await readFile(path.join(sourcePluginRoot, "plugin.json"))
    const sourceIconBefore = await readFile(
      path.join(sourcePluginRoot, "assets", "lyrashield-400.png")
    )

    const pluginRoot = await createIsolatedPluginRoot()
    await buildPlugin({
      pluginRoot,
      logoAssetPath: path.resolve(
        getPluginDir(),
        "../../../docs/marketplace/assets/lyrashield-400.png"
      ),
    })

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
      if (["review-changes", "scan-project", "fix-and-retest"].includes(skillName)) {
        expect(content).toContain("idempotencyKey")
        expect(content).toContain("identical retries")
        expect(content).not.toMatch(/when (that field is available|exposed by the tool)/)
      }
      if (["scan-project", "fix-and-retest"].includes(skillName)) {
        expect(content).toContain("20 checks")
        expect(content).toContain("30 seconds")
        expect(content).toMatch(/resume (it|that retest) later/)
      }
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

    const pluginManifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf-8"))
    const openAi = pluginManifest.extensions?.["com.openai"]
    expect(pluginManifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    )
    expect(openAi.interface).toMatchObject({
      displayName: "LyraShield AI",
      shortDescription: "Code review and readiness",
      developerName: "LyraShield AI",
      websiteURL: "https://lyrashieldai.com",
      supportURL: "https://lyrashieldai.com/support",
      privacyPolicyURL: "https://lyrashieldai.com/privacy",
      termsOfServiceURL: "https://lyrashieldai.com/terms",
      logo: "./assets/lyrashield-400.png",
      composerIcon: "./assets/lyrashield-400.png",
      defaultPrompt: [
        "Review this diff without starting a recorded scan.",
        "Check readiness evidence for my authorized project.",
      ],
    })
    expect(openAi.interface.category).toBeUndefined()
    expect(openAi.interface.screenshots).toBeUndefined()
    expect(openAi.onboardingSkill).toBe("./skills/get-started/SKILL.md")
    expect(openAi.review.demo_recording_url).toBeUndefined()
    expect(openAi.review.test_cases.positive).toHaveLength(5)
    expect(openAi.review.test_cases.negative).toHaveLength(3)
    for (const testCase of openAi.review.test_cases.positive) {
      expect(testCase.prompt).toBeTruthy()
      expect(testCase.expected_behavior).toBeTruthy()
      for (const toolName of testCase.tools_triggered
        .split(",")
        .map((name: string) => name.trim())) {
        expect(declaredTools.has(toolName), `OpenAI reviewer case references ${toolName}`).toBe(
          true
        )
      }
    }
    for (const testCase of openAi.review.test_cases.negative) {
      expect(testCase.prompt).toBeTruthy()
      expect(testCase.description).toMatch(/Expected:/)
    }
    expect(openAi.publication.release_notes).toContain("0.1.31")
    await expect(access(path.join(pluginRoot, openAi.onboardingSkill))).resolves.toBeUndefined()
    const iconPath = path.resolve(pluginRoot, openAi.interface.logo)
    const relativeIconPath = path.relative(pluginRoot, iconPath)
    expect(relativeIconPath).toBe(path.join("assets", "lyrashield-400.png"))
    const iconBytes = await readFile(iconPath)
    expect(iconBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(iconBytes.readUInt32BE(16)).toBe(400)
    expect(iconBytes.readUInt32BE(20)).toBe(400)
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
      else expect(JSON.parse(content).extensions?.["com.openai"]).toBeUndefined()
    }

    const codexManifest = JSON.parse(
      await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf-8")
    )
    expect(codexManifest.mcpServers).toBe("./.mcp.codex.json")
    expect(codexManifest.interface).toEqual(openAi.interface)
    expect(codexManifest.extensions["com.openai"].interface).toBeUndefined()
    expect(codexManifest.extensions["com.openai"].onboardingSkill).toBe(openAi.onboardingSkill)
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
    expect(marketplace.version).toBe(pluginManifest.version)
    expect(marketplace.plugins[0].version).toBe(pluginManifest.version)
    await expect(readFile(path.join(sourcePluginRoot, "plugin.json"))).resolves.toEqual(
      sourceManifestBefore
    )
    await expect(
      readFile(path.join(sourcePluginRoot, "assets", "lyrashield-400.png"))
    ).resolves.toEqual(sourceIconBefore)
  })

  it("leaves every generated manifest valid during concurrent builds", async () => {
    const pluginRoot = await createIsolatedPluginRoot()
    const logoAssetPath = path.resolve(
      getPluginDir(),
      "../../../docs/marketplace/assets/lyrashield-400.png"
    )
    await Promise.all(Array.from({ length: 4 }, () => buildPlugin({ pluginRoot, logoAssetPath })))

    for (const client of ["claude", "cursor", "codex", "kiro"]) {
      const shim = path.join(pluginRoot, `.${client}-plugin`, "plugin.json")
      const content = await readFile(shim, "utf-8")
      expect(() => JSON.parse(content)).not.toThrow()
    }
    const generatedFiles = await readdir(pluginRoot, { recursive: true })
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })
})
