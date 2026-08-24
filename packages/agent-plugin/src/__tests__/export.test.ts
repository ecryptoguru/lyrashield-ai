/* eslint-disable security/detect-non-literal-fs-filename */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createAllTools } from "@lyrashield/mcp"
import { exportMarketplace } from "../export.js"

const execFileAsync = promisify(execFile)

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
      artifactVersions?: Record<string, string>
      mutatingTools?: string[]
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
      version: "0.1.17",
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
      version: "0.1.17",
      owner: { name: "LyraShield AI" },
    })
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "lyrashield",
      source: "./",
      version: "0.1.17",
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
      lyrashield: { type: "streamable-http", url: "https://app.lyrashieldai.com/api/mcp" },
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

    // Gemini policy is catalog-derived: the exporter must emit the exact set of
    // mutating tools recorded in the MCP catalog, into both gemini manifests.
    const mutating = createAllTools({ apiBaseUrl: "", apiKey: "" })
      .filter((tool) => tool.mutating)
      .map((tool) => tool.name)
    expect(manifest.mutatingTools).toEqual(mutating)
    for (const location of ["gemini-extension.json", "gemini-extension/gemini-extension.json"]) {
      const gemini = JSON.parse(await readFile(path.join(output, location), "utf8")) as {
        excludeTools?: string[]
        version?: string
      }
      expect(gemini.excludeTools).toEqual(mutating)
      expect(gemini.version).toBe(manifest.artifactVersions?.gemini)
    }

    // Manifest versions must match each artifact's own source-of-truth file.
    expect(manifest.artifactVersions).toEqual({
      zed: "0.1.1",
      gemini: "0.1.0",
      codebuff: "0.1.2",
      openclaw: "0.1.0",
    })
  })
})

describe("exported validator", () => {
  it("passes against a fresh temp-dir export", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)
    await expect(runValidator(output)).resolves.toContain("Marketplace validation passed")
  })

  it("fails when an artifact version drifts from the manifest", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const manifestPath = path.join(output, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifactVersions: Record<string, string>
    }
    manifest.artifactVersions.zed = "9.9.9"
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    await expect(runValidator(output)).rejects.toThrow(
      /manifest\.artifactVersions\.zed \(9\.9\.9\) must match/
    )
  })

  it("fails when a nested forbidden credential file enters the export", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const nested = path.join(output, "reviewer-pack", "fixture")
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, ".env.production"), "TOKEN=placeholder\n", "utf8")

    await expect(runValidator(output)).rejects.toThrow(/forbidden file present \(nested\)/)
  })

  it("fails when the exported gemini excludeTools drift from the manifest", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const geminiPath = path.join(output, "gemini-extension", "gemini-extension.json")
    const gemini = JSON.parse(await readFile(geminiPath, "utf8")) as { excludeTools: string[] }
    gemini.excludeTools = [...gemini.excludeTools.slice(0, -1)]
    await writeFile(geminiPath, `${JSON.stringify(gemini, null, 2)}\n`, "utf8")

    await expect(runValidator(output)).rejects.toThrow(/excludeTools must equal/)
  })
})

/**
 * Runs the exported validator (the exact scripts/validate.mjs shipped into the
 * tree) against an exported marketplace directory.
 */
async function runValidator(output: string): Promise<string> {
  const validator = path.join(output, "scripts", "validate.mjs")
  await access(validator)
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator], { cwd: output })
    return stdout
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}
