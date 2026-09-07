/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { MUTATING_TOOL_NAMES } from "@lyrashield/mcp/tool-policy"
import { buildPlugin } from "./build.js"
import { getPluginDir } from "./index.js"

const PUBLIC_FILES = [
  "README.md",
  "CHANGELOG.md",
  "CLIENT-CONTRACTS.md",
  "plugin.json",
  "mcp.json",
  "skills",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".kiro-plugin/plugin.json",
  ".mcp.json",
  ".mcp.codex.json",
  ".mcp.kiro.json",
] as const

const MARKETPLACE_ARTIFACTS = [
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
] as const

const GENERATED_FILES = [
  ...PUBLIC_FILES,
  "gemini-extension.json",
  "mcp-env.cjs",
  "GEMINI.md",
  "LICENSE",
  ...MARKETPLACE_ARTIFACTS,
] as const
const execFileAsync = promisify(execFile)

export interface MarketplaceExportOptions {
  /** Release exports require a clean source checkout; ordinary local exports stay unpublished. */
  publish?: boolean
}

/** Gemini excludes exactly the catalog's mutating tools; the list is never hardcoded here. */
const GEMINI_EXCLUDED_TOOLS: readonly string[] = MUTATING_TOOL_NAMES

function firstMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern)
  if (!match?.[1]) throw new Error(`Could not parse ${label} version from marketplace artifact`)
  return match[1]
}

/** Versions are parsed from each artifact's own source-of-truth file so manifest and artifact cannot drift. */
async function collectArtifactVersions(marketplaceDocs: string): Promise<Record<string, string>> {
  const [geminiTemplate, zedToml, codebuffAgent, openclawSkill] = await Promise.all([
    readFile(path.join(marketplaceDocs, "gemini-extension", "gemini-extension.json"), "utf8"),
    readFile(path.join(marketplaceDocs, "zed-extension", "extension.toml"), "utf8"),
    readFile(path.join(marketplaceDocs, "codebuff", "lyrashield-review.ts"), "utf8"),
    readFile(path.join(marketplaceDocs, "openclaw", "SKILL.md"), "utf8"),
  ])
  return {
    gemini: firstMatch(geminiTemplate, /"version"\s*:\s*"([^"]+)"/, "gemini-extension.json"),
    zed: firstMatch(zedToml, /^version\s*=\s*"([^"]+)"/m, "zed extension.toml"),
    codebuff: firstMatch(codebuffAgent, /^\s*version:\s*"([^"]+)"/m, "codebuff agent"),
    openclaw: firstMatch(openclawSkill, /^version:\s*(\S+)\s*$/m, "openclaw SKILL.md"),
  }
}

/** Generate the Gemini extension manifest: template content plus the catalog-derived excludeTools list. */
async function writeGeminiManifest(
  marketplaceDocs: string,
  destinationRoot: string,
  destinationSubdir: string
): Promise<void> {
  const templatePath = path.join(marketplaceDocs, "gemini-extension", "gemini-extension.json")
  const template = JSON.parse(await readFile(templatePath, "utf8")) as Record<string, unknown>
  delete template.excludeTools
  // Keep key order stable: everything from the template, then excludeTools last.
  const generated = JSON.stringify(
    { ...template, excludeTools: [...GEMINI_EXCLUDED_TOOLS] },
    null,
    2
  )
  await writeFile(path.join(destinationRoot, "gemini-extension.json"), `${generated}\n`, "utf8")
  await writeFile(
    path.join(destinationSubdir, "gemini-extension", "gemini-extension.json"),
    `${generated}\n`,
    "utf8"
  )
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args])
  return stdout.trim()
}

async function listExportFiles(
  root: string,
  directory = root
): Promise<Array<{ path: string; sha256: string; mode: number }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: Array<{ path: string; sha256: string; mode: number }> = []
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const fullPath = path.join(directory, entry.name)
    const relative = path.relative(root, fullPath).split(path.sep).join("/")
    const stat = await lstat(fullPath)
    if (stat.isSymbolicLink()) throw new Error(`Marketplace export rejects symlink: ${relative}`)
    if (stat.isDirectory()) {
      files.push(...(await listExportFiles(root, fullPath)))
    } else if (stat.isFile()) {
      if (relative === "manifest.json") continue
      files.push({
        path: relative,
        sha256: createHash("sha256")
          .update(await readFile(fullPath))
          .digest("hex"),
        mode: stat.mode & 0o777,
      })
    } else {
      throw new Error(`Marketplace export rejects unsupported entry: ${relative}`)
    }
  }
  return files
}

async function assertEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length > 0) {
    throw new Error("Marketplace export destination must be empty")
  }
}

/** Export only installable client artifacts; hosted service code never crosses this boundary. */
export async function exportMarketplace(
  destination: string,
  { publish = false }: MarketplaceExportOptions = {}
): Promise<void> {
  const pluginRoot = getPluginDir()
  const repoRoot = path.resolve(pluginRoot, "../../..")
  const marketplaceDocs = path.join(repoRoot, "docs", "marketplace")
  const [sourceCommit, dirtySource] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]),
  ])
  if (publish && dirtySource)
    throw new Error("Marketplace publication requires a clean source checkout")
  await buildPlugin()
  await assertEmptyDestination(destination)

  for (const relative of PUBLIC_FILES) {
    const source =
      relative === "README.md" || relative === "CHANGELOG.md" || relative === "CLIENT-CONTRACTS.md"
        ? path.join(marketplaceDocs, relative)
        : path.join(pluginRoot, relative)
    await cp(source, path.join(destination, relative), {
      recursive: true,
      force: true,
    })
  }
  await cp(
    path.join(marketplaceDocs, "gemini-extension", "mcp-env.cjs"),
    path.join(destination, "mcp-env.cjs"),
    { force: true }
  )
  await cp(
    path.join(marketplaceDocs, "gemini-extension", "GEMINI.md"),
    path.join(destination, "GEMINI.md"),
    { force: true }
  )
  await cp(path.join(marketplaceDocs, "LICENSE"), path.join(destination, "LICENSE"), {
    force: true,
  })
  for (const relative of MARKETPLACE_ARTIFACTS) {
    await cp(path.join(marketplaceDocs, relative), path.join(destination, relative), {
      recursive: true,
      force: true,
      filter: (source) => !["target", "node_modules", ".git"].includes(path.basename(source)),
    })
  }

  const [pluginContent, generatorContent] = await Promise.all([
    readFile(path.join(pluginRoot, "plugin.json"), "utf8"),
    readFile(path.resolve(pluginRoot, "..", "package.json"), "utf8"),
  ])
  const plugin = JSON.parse(pluginContent) as { name?: string; version?: string; license?: string }
  const generator = JSON.parse(generatorContent) as { version?: string }
  if (plugin.license !== "Apache-2.0") throw new Error("Marketplace plugin must be Apache-2.0")

  const [artifactVersions] = await Promise.all([
    collectArtifactVersions(marketplaceDocs),
    writeGeminiManifest(marketplaceDocs, destination, destination),
  ])

  const files = await listExportFiles(destination)
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        license: plugin.license,
        source: "@lyrashield/agent-plugin",
        manifestSchemaVersion: "marketplace-export/2",
        sourceCommit,
        generator: { package: "@lyrashield/agent-plugin", version: generator.version },
        publication: {
          status: publish ? "release-candidate" : "unpublished",
          sourceClean: !dirtySource,
        },
        files,
        generatedFiles: GENERATED_FILES,
        artifactVersions,
        mutatingTools: [...GEMINI_EXCLUDED_TOOLS],
        forbidden: [
          "apps/web",
          "apps/worker",
          "apps/agent",
          "packages/db",
          ".env",
          "credentials.json",
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [destinationArg, ...args] = process.argv.slice(2)
  const destination = destinationArg ?? path.resolve(process.cwd(), "marketplace-export")
  await exportMarketplace(destination, { publish: args.includes("--publish") })
  console.log(`Exported LyraShield marketplace artifacts to ${destination}`)
}
