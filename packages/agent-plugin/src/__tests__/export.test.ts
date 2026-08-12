/* eslint-disable security/detect-non-literal-fs-filename */
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportMarketplace } from "../export.js"

const outputs: string[] = []
afterEach(async () => {
  await Promise.all(
    outputs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("exportMarketplace", () => {
  it("exports only the public client boundary with provenance", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")) as {
      license: string
      forbidden: string[]
      generatedFiles: string[]
    }
    const plugin = JSON.parse(await readFile(path.join(output, "plugin.json"), "utf8")) as {
      license: string
    }
    expect(plugin.license).toBe("Apache-2.0")
    expect(manifest.license).toBe("Apache-2.0")
    expect(manifest.forbidden).toContain("apps/worker")
    await expect(readFile(path.join(output, "README.md"), "utf8")).resolves.toContain(
      "marketplace release"
    )
    await expect(readFile(path.join(output, "CHANGELOG.md"), "utf8")).resolves.toContain("0.1.0")
    await expect(readFile(path.join(output, "gemini-extension.json"), "utf8")).resolves.toContain(
      "lyrashield-ai"
    )
    await expect(readFile(path.join(output, "GEMINI.md"), "utf8")).resolves.toContain("read-only")
    await expect(readFile(path.join(output, "plugin.json"), "utf8")).resolves.toContain(
      "LyraShield AI"
    )
    const portableMcp = JSON.parse(await readFile(path.join(output, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { type?: string; url?: string; headers?: unknown }>
    }
    expect(portableMcp.mcpServers).toEqual({
      lyrashield: {
        type: "streamable-http",
        url: "https://app.lyrashieldai.com/api/mcp",
      },
    })
    await expect(access(path.join(output, "plugin"))).rejects.toThrow()
    const claudeManifest = JSON.parse(
      await readFile(path.join(output, ".claude-plugin", "plugin.json"), "utf8")
    ) as { $schema?: string; repository?: string; version?: string }
    const claudeMcp = JSON.parse(await readFile(path.join(output, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { type?: string; url?: string }>
    }
    expect(claudeManifest).toMatchObject({
      $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
      repository: "https://github.com/ecryptoguru/lyrashield-marketplace",
      version: "0.1.16",
    })
    // The marketplace catalog is what makes the exported repo addressable via
    // `/plugin marketplace add` and VS Code's "Install Plugin From Source".
    // `source: "./"` must stay pointed at the marketplace root, where plugin.json lives.
    const marketplace = JSON.parse(
      await readFile(path.join(output, ".claude-plugin", "marketplace.json"), "utf8")
    ) as {
      name?: string
      version?: string
      owner?: { name?: string }
      plugins?: { name?: string; source?: string; version?: string; license?: string }[]
    }
    expect(marketplace).toMatchObject({
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "lyrashield-ai",
      version: "0.1.16",
      owner: { name: "LyraShield AI" },
    })
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "lyrashield",
      source: "./",
      version: "0.1.16",
      license: "Apache-2.0",
    })
    const codexManifest = JSON.parse(
      await readFile(path.join(output, ".codex-plugin", "plugin.json"), "utf8")
    ) as { $schema?: string; skills?: string }
    expect(codexManifest).toMatchObject({ skills: "./skills/" })
    expect(codexManifest.$schema).toBeUndefined()
    expect(claudeMcp.mcpServers).toEqual({
      lyrashield: {
        type: "streamable-http",
        url: "https://app.lyrashieldai.com/api/mcp",
      },
    })
    const cursorManifest = JSON.parse(
      await readFile(path.join(output, ".cursor-plugin", "plugin.json"), "utf8")
    ) as { mcpServers?: Record<string, unknown>; variables?: unknown }
    expect(cursorManifest.mcpServers).toEqual({
      lyrashield: { url: "https://app.lyrashieldai.com/api/mcp" },
    })
    expect(cursorManifest.variables).toBeUndefined()
    const kiroMcp = JSON.parse(await readFile(path.join(output, ".mcp.kiro.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>
    }
    expect(kiroMcp.mcpServers?.lyrashield?.env).toEqual({
      LYRASHIELD_API_URL: "https://app.lyrashieldai.com",
    })
    await expect(
      readFile(path.join(output, "skills", "lyrashield", "SKILL.md"), "utf8")
    ).resolves.toContain("Pre-PR check")
    await expect(readFile(path.join(output, "apps", "worker"))).rejects.toThrow()
    await expect(
      readFile(path.join(output, "zed-extension", "extension.toml"), "utf8")
    ).resolves.toContain("lyrashield-mcp")
    await expect(
      readFile(path.join(output, "codebuff", "lyrashield-review.ts"), "utf8")
    ).resolves.toMatch(/id: "lyrashield-review"[\s\S]*version: "0\.1\.2"[\s\S]*mcpServers:/)
    await expect(
      readFile(path.join(output, "gemini-extension", "gemini-extension.json"), "utf8")
    ).resolves.toContain("lyrashield-ai")
    await expect(readFile(path.join(output, "kiro-power", "POWER.md"), "utf8")).resolves.toContain(
      "Apache-2.0"
    )
    await expect(
      readFile(path.join(output, "cline", "submission.json"), "utf8")
    ).resolves.toContain("lyrashield.read")
    await expect(
      readFile(path.join(output, "kilo", "marketplace.json"), "utf8")
    ).resolves.toContain("lyrashield.write")
    await expect(readFile(path.join(output, "openclaw", "SKILL.md"), "utf8")).resolves.toContain(
      "community ClawHub listing"
    )
    await expect(readFile(path.join(output, "openclaw", "SKILL.md"), "utf8")).resolves.toContain(
      "license: MIT-0"
    )
    await expect(readFile(path.join(output, "openclaw", "LICENSE"), "utf8")).resolves.toContain(
      "MIT No Attribution"
    )
    await expect(readFile(path.join(output, "LICENSE"), "utf8")).resolves.toContain(
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"
    )
    expect(manifest.generatedFiles).toEqual([
      "README.md",
      "CHANGELOG.md",
      "plugin.json",
      "mcp.json",
      "skills",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      ".kiro-plugin/plugin.json",
      ".mcp.json",
      ".mcp.kiro.json",
      "gemini-extension.json",
      "GEMINI.md",
      "LICENSE",
      "zed-extension",
      "codebuff",
      "gemini-extension",
      "kiro-power",
      "cline",
      "kilo",
      "openclaw",
      "reviewer-pack",
      "assets",
      "scripts",
      ".github",
    ])
    await expect(
      readFile(path.join(output, "assets", "lyrashield-400.svg"), "utf8")
    ).resolves.toContain('width="400"')
    const icon = await readFile(path.join(output, "assets", "lyrashield-400.png"))
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })
})
