/* eslint-disable security/detect-non-literal-fs-filename */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createAllTools } from "@lyrashield/mcp"
import { exportMarketplace } from "../export.js"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

async function updateManifestHash(output: string, relative: string): Promise<void> {
  const manifestPath = path.join(output, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>
  }
  const file = manifest.files.find((entry) => entry.path === relative)
  if (!file) throw new Error(`Missing manifest entry for ${relative}`)
  file.sha256 = createHash("sha256")
    .update(await readFile(path.join(output, relative)))
    .digest("hex")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

const outputs: string[] = []
afterEach(async () => {
  await Promise.all(
    outputs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("exportMarketplace", () => {
  it("rejects release-candidate exports from a dirty source checkout", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    const dirtyMarker = path.join(
      repoRoot,
      `.marketplace-export-dirty-${process.pid}-${Date.now()}`
    )
    outputs.push(output)
    await writeFile(dirtyMarker, "test marker\n", "utf8")
    try {
      await expect(exportMarketplace(output, { publish: true })).rejects.toThrow(
        /requires a clean source checkout/
      )
    } finally {
      await rm(dirtyMarker, { force: true })
    }
  })

  it("does not let documented placeholders hide other credentials on the same line", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-validator-"))
    outputs.push(output)
    await exportMarketplace(output)
    const probe = path.join(output, "README.md")
    const original = await readFile(probe, "utf8")
    await writeFile(probe, `${original}\nExamples: <YOUR_API_KEY> lsk_… lsk_...\n`)
    await updateManifestHash(output, "README.md")
    await execFileAsync(process.execPath, ["scripts/validate.mjs"], { cwd: output })
    for (const secret of ["lsk" + "_" + "A".repeat(24), "gh" + "p_" + "A".repeat(36)]) {
      await writeFile(probe, `${original}\nExample: <YOUR_API_KEY> lsk_… actual: ${secret}\n`)
      await updateManifestHash(output, "README.md")
      await expect(
        execFileAsync(process.execPath, ["scripts/validate.mjs"], { cwd: output })
      ).rejects.toThrow(/detected at README.md/)
    }
  }, 15000)

  it("rejects undeclared files added after export", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-validator-"))
    outputs.push(output)
    await exportMarketplace(output)
    await writeFile(path.join(output, "probe.txt"), "untracked\n")
    await expect(
      execFileAsync(process.execPath, ["scripts/validate.mjs"], { cwd: output })
    ).rejects.toThrow(/file set or hash differs/)
  }, 15000)

  it("preserves explicit API URL overrides for stored OAuth in npm and embedded Zed launchers", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield extension "))
    outputs.push(output)
    await exportMarketplace(output)
    const gemini = JSON.parse(await readFile(path.join(output, "gemini-extension.json"), "utf8"))
    const preloadOption = gemini.mcpServers.lyrashield.args[1].replace("${extensionPath}", output)
    const preload = await readFile(path.join(output, "zed-extension/mcp-env.cjs"), "utf8")
    const probe = `process.stdout.write(JSON.stringify({
      key: process.env.LYRASHIELD_API_KEY,
      url: process.env.LYRASHIELD_API_URL,
      oauth: process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN,
      temporary: process.env.LYRASHIELD_EXTENSION_CRED
    }))`
    const probePath = path.join(output, "stdio probe.mjs")
    await writeFile(probePath, probe)
    for (const setting of [undefined, "", "  ", " demo-credential "]) {
      const env = {
        PATH: process.env.PATH,
        HOME: output,
        LYRASHIELD_API_URL: "https://override.example.test",
        LYRASHIELD_API_KEY: "inherited-credential",
        LYRASHIELD_OAUTH_ACCESS_TOKEN: "inherited-token",
        ...(setting === undefined ? {} : { LYRASHIELD_EXTENSION_CRED: setting }),
      }
      const expected = setting?.trim()
        ? { key: "demo-credential", url: "https://app.lyrashieldai.com" }
        : { url: "https://override.example.test" }
      // npm's own Node option forwarding and paths with spaces are part of the
      // Gemini launch contract. This uses the installed Node, with no download.
      const geminiResult = await execFileAsync(
        "npx",
        ["--no", preloadOption, "--", "node", "--eval", probe],
        { cwd: output, env }
      )
      expect(JSON.parse(geminiResult.stdout)).toEqual(expected)
      const zedResult = await execFileAsync(
        process.execPath,
        [
          "--eval",
          `${preload}\nimport(require('node:url').pathToFileURL(process.argv[1]).href)`,
          probePath,
        ],
        { cwd: output, env }
      )
      expect(JSON.parse(zedResult.stdout)).toEqual(expected)
    }
  }, 15000)

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
      manifestSchemaVersion?: string
      sourceCommit?: string
      generator?: { package?: string; version?: string }
      publication?: { status?: string }
      files?: { path: string; sha256: string; mode: number }[]
    }
    const plugin = JSON.parse(await readFile(path.join(output, "plugin.json"), "utf8")) as {
      license: string
    }
    expect(plugin.license).toBe("Apache-2.0")
    expect(manifest.license).toBe("Apache-2.0")
    expect(manifest.forbidden).toContain("apps/worker")
    expect(manifest.manifestSchemaVersion).toBe("marketplace-export/2")
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.generator).toEqual({ package: "@lyrashield/agent-plugin", version: "0.1.24" })
    expect(manifest.publication?.status).toBe("unpublished")
    expect(manifest.files?.some((file) => file.path === "manifest.json")).toBe(false)
    const exportedPaths = manifest.files?.map((file) => file.path) ?? []
    expect(exportedPaths.indexOf("CHANGELOG.md")).toBeLessThan(
      exportedPaths.indexOf("assets/lyrashield-400.png")
    )
    expect(exportedPaths.indexOf("gemini-extension/GEMINI.md")).toBeLessThan(
      exportedPaths.indexOf("gemini-extension.json")
    )
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
        type: "http",
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
      version: "0.1.24",
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
      version: "0.1.24",
      owner: { name: "LyraShield AI" },
    })
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "lyrashield",
      source: "./",
      version: "0.1.24",
      license: "Apache-2.0",
    })
    const codexManifest = JSON.parse(
      await readFile(path.join(output, ".codex-plugin", "plugin.json"), "utf8")
    ) as { $schema?: string; skills?: string; mcpServers?: string }
    expect(codexManifest).toMatchObject({
      skills: "./skills/",
      mcpServers: "./.mcp.codex.json",
    })
    expect(codexManifest.$schema).toBeUndefined()
    const codexMcp = JSON.parse(await readFile(path.join(output, ".mcp.codex.json"), "utf8"))
    expect(codexMcp).toEqual({
      lyrashield: { url: "https://app.lyrashieldai.com/api/mcp" },
    })
    const codexMarketplace = JSON.parse(
      await readFile(path.join(output, ".agents", "plugins", "marketplace.json"), "utf8")
    )
    expect(codexMarketplace.plugins?.[0]).toMatchObject({
      name: "lyrashield",
      version: "0.1.24",
      source: { source: "local", path: "./codex-plugin" },
    })
    const installedCodexManifest = JSON.parse(
      await readFile(path.join(output, "codex-plugin", ".codex-plugin", "plugin.json"), "utf8")
    )
    expect(installedCodexManifest).toMatchObject({
      name: "lyrashield",
      version: "0.1.24",
      mcpServers: "./.mcp.json",
    })
    expect(
      JSON.parse(await readFile(path.join(output, "codex-plugin", ".mcp.json"), "utf8"))
    ).toEqual({
      lyrashield: {
        type: "streamable-http",
        url: "https://app.lyrashieldai.com/api/mcp",
      },
    })
    expect(claudeMcp.mcpServers).toEqual({
      lyrashield: {
        type: "http",
        url: "https://app.lyrashieldai.com/api/mcp",
      },
    })
    const cursorManifest = JSON.parse(
      await readFile(path.join(output, ".cursor-plugin", "plugin.json"), "utf8")
    ) as { mcpServers?: Record<string, unknown>; variables?: unknown }
    expect(cursorManifest.mcpServers).toEqual({
      lyrashield: { type: "http", url: "https://app.lyrashieldai.com/api/mcp" },
    })
    expect(cursorManifest.variables).toBeUndefined()
    const kiroMcp = JSON.parse(await readFile(path.join(output, ".mcp.kiro.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>
    }
    expect(kiroMcp.mcpServers?.lyrashield?.env).toBeUndefined()
    await expect(
      readFile(path.join(output, "skills", "lyrashield", "SKILL.md"), "utf8")
    ).resolves.toContain("Pre-PR check")
    await expect(readFile(path.join(output, "apps", "worker"))).rejects.toThrow()
    await expect(
      readFile(path.join(output, "zed-extension", "extension.toml"), "utf8")
    ).resolves.toContain("lyrashield-mcp")
    await expect(
      readFile(path.join(output, "codebuff", "lyrashield-review.ts"), "utf8")
    ).resolves.toMatch(/id: "lyrashield-review"[\s\S]*version: "0\.1\.24"[\s\S]*mcpServers:/)
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
      "CLIENT-CONTRACTS.md",
      "plugin.json",
      "mcp.json",
      "skills",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      ".kiro-plugin/plugin.json",
      ".mcp.json",
      ".mcp.codex.json",
      ".mcp.kiro.json",
      "codex-plugin",
      "gemini-extension.json",
      "mcp-env.cjs",
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
      zed: "0.1.24",
      gemini: "0.1.24",
      codebuff: "0.1.24",
      openclaw: "0.1.24",
    })
  })
})

describe("exported validator", () => {
  it.each([
    [
      ".mcp.kiro.json",
      '"command": "npx"',
      '"env": {"LYRASHIELD_API_URL":"https://app.lyrashieldai.com"}, "command": "npx"',
    ],
    ["gemini-extension.json", "@lyrashield/mcp@0.2.5", "@lyrashield/mcp"],
    ["codebuff/lyrashield-review.ts", '"read_files"', '"run_terminal_command", "read_files"'],
    ["openclaw/SKILL.md", "nothing is applied automatically.", "changes apply automatically."],
  ])("rejects unsafe distribution drift in %s", async (file, before, after) => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)
    const target = path.join(output, file)
    await writeFile(target, (await readFile(target, "utf8")).replace(before, after))
    await expect(
      execFileAsync(process.execPath, [path.join(output, "scripts", "validate.mjs")], {
        cwd: output,
      })
    ).rejects.toMatchObject({ stdout: "" })
  })

  it("passes against a fresh temp-dir export", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)
    await expect(runValidator(output)).resolves.toContain("Marketplace validation passed")
  })

  it("ignores repository metadata while validating the exported tree", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)
    const gitMetadata = path.join(output, ".git", "objects")
    await mkdir(gitMetadata, { recursive: true })
    await writeFile(path.join(gitMetadata, "probe"), "repository metadata\n", "utf8")
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

    await expect(runValidator(output)).rejects.toThrow(/manifest\.artifactVersions\.zed/)
  })

  it("fails when a nested forbidden credential file enters the export", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const nested = path.join(output, "reviewer-pack", "fixture")
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, ".env.production"), "TOKEN=placeholder\n", "utf8")

    await expect(runValidator(output)).rejects.toThrow(/file set or hash differs/)
  })

  it("fails when the exported gemini excludeTools drift from the manifest", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(output)
    await exportMarketplace(output)

    const geminiPath = path.join(output, "gemini-extension", "gemini-extension.json")
    const gemini = JSON.parse(await readFile(geminiPath, "utf8")) as { excludeTools: string[] }
    gemini.excludeTools = [...gemini.excludeTools.slice(0, -1)]
    await writeFile(geminiPath, `${JSON.stringify(gemini, null, 2)}\n`, "utf8")

    await expect(runValidator(output)).rejects.toThrow(/file set or hash differs/)
  })

  it("produces identical clean exports from one source commit", async () => {
    const first = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    const second = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-"))
    outputs.push(first, second)
    await exportMarketplace(first)
    await exportMarketplace(second)
    expect(await readFile(path.join(first, "manifest.json"), "utf8")).toBe(
      await readFile(path.join(second, "manifest.json"), "utf8")
    )
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
