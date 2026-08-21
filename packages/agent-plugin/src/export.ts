/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MUTATING_TOOL_NAMES } from "@lyrashield/mcp/tool-policy"
import { buildPlugin } from "./build.js"
import { getPluginDir } from "./index.js"

const PUBLIC_FILES = [
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
  "GEMINI.md",
  "LICENSE",
  ...MARKETPLACE_ARTIFACTS,
] as const

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

/** Export only installable client artifacts; hosted service code never crosses this boundary. */
export async function exportMarketplace(destination: string): Promise<void> {
  const pluginRoot = getPluginDir()
  const repoRoot = path.resolve(pluginRoot, "../../..")
  const marketplaceDocs = path.join(repoRoot, "docs", "marketplace")
  await buildPlugin()
  await mkdir(destination, { recursive: true })

  for (const relative of PUBLIC_FILES) {
    const source =
      relative === "README.md" || relative === "CHANGELOG.md"
        ? path.join(marketplaceDocs, relative)
        : path.join(pluginRoot, relative)
    await cp(source, path.join(destination, relative), {
      recursive: true,
      force: true,
    })
  }
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
    })
  }

  const plugin = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as {
    name?: string
    version?: string
    license?: string
  }
  if (plugin.license !== "Apache-2.0") throw new Error("Marketplace plugin must be Apache-2.0")

  const [artifactVersions] = await Promise.all([
    collectArtifactVersions(marketplaceDocs),
    writeGeminiManifest(marketplaceDocs, destination, destination),
  ])

  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        license: plugin.license,
        source: "@lyrashield/agent-plugin",
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
  const destination = process.argv[2] ?? path.resolve(process.cwd(), "marketplace-export")
  await exportMarketplace(destination)
  console.log(`Exported LyraShield marketplace artifacts to ${destination}`)
}
