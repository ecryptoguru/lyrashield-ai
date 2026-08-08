/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
    }
    const plugin = JSON.parse(
      await readFile(path.join(output, "plugin", "plugin.json"), "utf8")
    ) as {
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
    const claudeManifest = JSON.parse(
      await readFile(path.join(output, ".claude-plugin", "plugin.json"), "utf8")
    ) as { $schema?: string; repository?: string; version?: string }
    const claudeMcp = JSON.parse(await readFile(path.join(output, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { type?: string; url?: string }>
    }
    expect(claudeManifest).toMatchObject({
      $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
      repository: "https://github.com/ecryptoguru/lyrashield-marketplace",
      version: "0.1.9",
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
    await expect(
      readFile(path.join(output, "skills", "lyrashield", "SKILL.md"), "utf8")
    ).resolves.toContain("Pre-PR check")
    await expect(readFile(path.join(output, "apps", "worker"))).rejects.toThrow()
    await expect(
      readFile(path.join(output, "zed-extension", "extension.toml"), "utf8")
    ).resolves.toContain("lyrashield-ai")
    await expect(
      readFile(path.join(output, "codebuff", "lyrashield-review.ts"), "utf8")
    ).resolves.toContain("lyrashield-review")
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
    await expect(
      readFile(path.join(output, "assets", "lyrashield-400.svg"), "utf8")
    ).resolves.toContain('width="400"')
    const icon = await readFile(path.join(output, "assets", "lyrashield-400.png"))
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })
})
