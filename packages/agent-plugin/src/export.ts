/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { MUTATING_TOOL_NAMES } from "@lyrashield/mcp/tool-policy"
import { buildPlugin } from "./build.js"
import { getPluginDir } from "./plugin-dir.js"

const PUBLIC_FILES = [
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
] as const

const MARKETPLACE_ARTIFACTS = [
  "zed-extension",
  "codebuff",
  "gemini-extension",
  "antigravity",
  "amp",
  "opencode",
  "kiro-power",
  "cline",
  "kilo",
  "openclaw",
  "aider",
  "augment",
  "continue",
  "devin-cli",
  "devin-desktop",
  "factory",
  "goose",
  "hermes",
  "jetbrains-ai-assistant",
  "jetbrains-junie",
  "lovable",
  "mcp-registry",
  "mimo-code",
  "mistral-vibe",
  "oh-my-pi",
  "roo-code",
  "pi",
  "qoder",
  "qwen",
  "replit",
  "v0",
  "reviewer-pack",
  "assets",
  "scripts",
  ".github",
] as const

const CLIENT_SKILL_ROOTS = [
  "antigravity/skills",
  "augment/plugins/lyrashield/skills",
  "cline/skills",
  "devin-cli/skills",
  "devin-desktop/skills",
  "factory/plugins/lyrashield/skills",
  "gemini-extension/skills",
  "goose/skills",
  "hermes/skills",
  "jetbrains-ai-assistant/skills",
  "jetbrains-junie/skills",
  "kilo/skills",
  "kiro-power/skills",
  "lovable/skills",
  "mimo-code/skills",
  "mistral-vibe/skills",
  "oh-my-pi/skills",
  "opencode/skills",
  "qoder/plugins/lyrashield/skills",
  "qwen/skills",
  "replit/skills",
  "roo-code/skills",
  "v0/skills",
] as const

const WORKFLOW_SKILL_NAMES = [
  "get-started",
  "review-changes",
  "scan-project",
  "fix-and-retest",
  "launch-readiness",
] as const

const SKILL_FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/
const BUILD_TEMPORARY_PATTERN = /^.+\.[a-f0-9-]{36}\.tmp$/i

const GENERATED_FILES = [
  ...PUBLIC_FILES,
  "gemini-extension.json",
  "mcp-env.cjs",
  "GEMINI.md",
  "LICENSE",
  ...MARKETPLACE_ARTIFACTS,
] as const
const execFileAsync = promisify(execFile)

function includeStableSource(source: string): boolean {
  return !BUILD_TEMPORARY_PATTERN.test(path.basename(source))
}

export interface MarketplaceExportOptions {
  /** Release exports require a clean source checkout; ordinary local exports stay unpublished. */
  publish?: boolean
}

interface BuiltMarketplaceContext {
  pluginRoot: string
  sourcePluginRoot: string
  marketplaceDocs: string
  sourceCommit: string
  dirtySource: string
  publish: boolean
}

/** Explicit scan and fix/retest tools remain available to invoked Gemini workflows; other mutations stay excluded. */
const GEMINI_EXPLICIT_WORKFLOW_TOOLS = [
  "lyrashield_scan_target",
  "lyrashield_run_pr_scan",
  "lyrashield_record_fix_proposal",
  "lyrashield_verify_fix",
] as const
const GEMINI_EXCLUDED_TOOLS: readonly string[] = MUTATING_TOOL_NAMES.filter(
  (name) =>
    !GEMINI_EXPLICIT_WORKFLOW_TOOLS.includes(
      name as (typeof GEMINI_EXPLICIT_WORKFLOW_TOOLS)[number]
    )
)

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
  const servers = template.mcpServers as Record<string, Record<string, unknown>>
  // MCP discovery filters original tool names before Gemini adds its namespace.
  servers.lyrashield!.excludeTools = [...GEMINI_EXCLUDED_TOOLS]
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

function splitSkillDocument(contents: string): { frontmatter: string; body: string } | undefined {
  const match = contents.match(SKILL_FRONTMATTER_PATTERN)
  if (!match) return undefined
  return { frontmatter: match[0], body: contents.slice(match[0].length) }
}

/**
 * Keep each client's frontmatter contract while taking the workflow procedure
 * from the canonical plugin skills. This retains, for example, Lovable's
 * trigger descriptions and Mistral Vibe's user-invocable slash-command flag.
 */
async function syncClientSkillRoot(
  canonicalRoot: string,
  destinationRoot: string,
  relative: string
): Promise<void> {
  const destination = path.join(destinationRoot, relative)
  const canonicalEntries = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const preservedFrontmatter = new Map<string, string>()

  for (const entry of canonicalEntries) {
    const destinationSkill = path.join(destination, entry.name, "SKILL.md")
    try {
      const existing = splitSkillDocument(await readFile(destinationSkill, "utf8"))
      if (existing) preservedFrontmatter.set(entry.name, existing.frontmatter)
    } catch (error) {
      // A client may add a workflow that is absent in its authored source.
      // In that case the canonical frontmatter is the safe default.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  await rm(destination, { recursive: true, force: true })
  await cp(canonicalRoot, destination, {
    recursive: true,
    filter: includeStableSource,
  })

  for (const entry of canonicalEntries) {
    const skillPath = path.join(destination, entry.name, "SKILL.md")
    const canonical = splitSkillDocument(await readFile(skillPath, "utf8"))
    if (!canonical) throw new Error(`Canonical skill ${entry.name} is missing frontmatter`)
    const frontmatter = preservedFrontmatter.get(entry.name) ?? canonical.frontmatter
    await writeFile(skillPath, `${frontmatter}${canonical.body}`, "utf8")
  }
}

function crc32(contents: Buffer): number {
  let crc = 0xffffffff
  for (const byte of contents) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a deterministic ZIP_STORED archive containing one root-level file. */
function createStoredZip(filename: string, contents: Buffer): Buffer {
  const name = Buffer.from(filename, "utf8")
  if (name.length > 0xffff || contents.length > 0xffffffff)
    throw new Error("Stored ZIP entry exceeds classic ZIP limits")

  const checksum = crc32(contents)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(0, 8) // ZIP_STORED
  local.writeUInt16LE(0, 10) // fixed DOS time
  local.writeUInt16LE(0x21, 12) // 1980-01-01
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0314, 4) // Unix, ZIP version 2.0
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8) // flags
  central.writeUInt16LE(0, 10) // ZIP_STORED
  central.writeUInt16LE(0, 12) // fixed DOS time
  central.writeUInt16LE(0x21, 14) // 1980-01-01
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30) // extra length
  central.writeUInt16LE(0, 32) // comment length
  central.writeUInt16LE(0, 34) // disk number
  central.writeUInt16LE(0, 36) // internal attributes
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  central.writeUInt32LE(0, 42) // local header offset

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // current disk
  end.writeUInt16LE(0, 6) // central directory disk
  end.writeUInt16LE(1, 8) // entries on this disk
  end.writeUInt16LE(1, 10) // total entries
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + contents.length, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([local, name, contents, central, name, end])
}

async function writeLovableSkillArchives(destinationRoot: string): Promise<void> {
  for (const skill of WORKFLOW_SKILL_NAMES) {
    const source = await readFile(
      path.join(destinationRoot, "lovable", "skills", skill, "SKILL.md")
    )
    await writeFile(
      path.join(destinationRoot, "lovable", "imports", `${skill}.zip`),
      createStoredZip("SKILL.md", source)
    )
  }
}

async function assertEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length > 0) {
    throw new Error("Marketplace export destination must be empty")
  }
}

async function exportBuiltMarketplace(
  destination: string,
  {
    pluginRoot,
    sourcePluginRoot,
    marketplaceDocs,
    sourceCommit,
    dirtySource,
    publish,
  }: BuiltMarketplaceContext
): Promise<void> {
  await assertEmptyDestination(destination)

  for (const relative of PUBLIC_FILES) {
    const source =
      relative === "README.md" || relative === "CHANGELOG.md" || relative === "CLIENT-CONTRACTS.md"
        ? path.join(marketplaceDocs, relative)
        : path.join(pluginRoot, relative)
    await cp(source, path.join(destination, relative), {
      recursive: true,
      force: true,
      filter: includeStableSource,
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
      filter: (source) => {
        const basename = path.basename(source)
        if (["target", "node_modules", ".git"].includes(basename)) return false
        // Client-bundle validators are source-tree maintainer tools. They refer
        // to sibling canonical files and must not ship as broken install assets.
        return !(basename === "validate.mjs" && path.basename(path.dirname(source)) !== "scripts")
      },
    })
  }

  // Keep every native Agent Skills package's procedure aligned with the
  // canonical workflows while retaining its own client-specific frontmatter.
  for (const relative of CLIENT_SKILL_ROOTS) {
    await syncClientSkillRoot(path.join(pluginRoot, "skills"), destination, relative)
  }

  // Amp discovers skills directly from its package directory.
  const workflowSkills = (await readdir(path.join(pluginRoot, "skills"))).filter(
    (name) => name !== "lyrashield"
  )
  const ampSkills = path.join(destination, "amp")
  for (const skill of workflowSkills) {
    await cp(
      path.join(pluginRoot, "skills", skill, "SKILL.md"),
      path.join(ampSkills, skill, "SKILL.md")
    )
  }

  const [pluginContent, generatorContent] = await Promise.all([
    readFile(path.join(pluginRoot, "plugin.json"), "utf8"),
    readFile(path.resolve(sourcePluginRoot, "..", "package.json"), "utf8"),
  ])
  const plugin = JSON.parse(pluginContent) as { name?: string; version?: string; license?: string }
  const generator = JSON.parse(generatorContent) as { version?: string }
  if (plugin.license !== "Apache-2.0") throw new Error("Marketplace plugin must be Apache-2.0")

  const [artifactVersions] = await Promise.all([
    collectArtifactVersions(marketplaceDocs),
    writeGeminiManifest(marketplaceDocs, destination, destination),
  ])

  await writeLovableSkillArchives(destination)

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
        mutatingTools: [...MUTATING_TOOL_NAMES],
        geminiAllowedMutatingTools: [...GEMINI_EXPLICIT_WORKFLOW_TOOLS],
        geminiExcludedTools: [...GEMINI_EXCLUDED_TOOLS],
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

/** Export only installable client artifacts; hosted service code never crosses this boundary. */
export async function exportMarketplace(
  destination: string,
  { publish = false }: MarketplaceExportOptions = {}
): Promise<void> {
  const sourcePluginRoot = getPluginDir()
  const repoRoot = path.resolve(sourcePluginRoot, "../../..")
  const marketplaceDocs = path.join(repoRoot, "docs", "marketplace")
  const [sourceCommit, dirtySource] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]),
  ])
  if (publish && dirtySource)
    throw new Error("Marketplace publication requires a clean source checkout")

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "lyrashield-marketplace-plugin-"))
  const pluginRoot = path.join(stagingRoot, "plugin")
  try {
    await cp(sourcePluginRoot, pluginRoot, {
      recursive: true,
      filter: includeStableSource,
    })
    await buildPlugin({
      pluginRoot,
      logoAssetPath: path.join(marketplaceDocs, "assets", "lyrashield-400.png"),
    })
    await exportBuiltMarketplace(destination, {
      pluginRoot,
      sourcePluginRoot,
      marketplaceDocs,
      sourceCommit,
      dirtySource,
      publish,
    })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [destinationArg, ...args] = process.argv.slice(2)
  const destination = destinationArg ?? path.resolve(process.cwd(), "marketplace-export")
  await exportMarketplace(destination, { publish: args.includes("--publish") })
  console.log(`Exported LyraShield marketplace artifacts to ${destination}`)
}
