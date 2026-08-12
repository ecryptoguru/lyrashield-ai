/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
    path.join(marketplaceDocs, "gemini-extension", "gemini-extension.json"),
    path.join(destination, "gemini-extension.json"),
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
    })
  }

  const plugin = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as {
    name?: string
    version?: string
    license?: string
  }
  if (plugin.license !== "Apache-2.0") throw new Error("Marketplace plugin must be Apache-2.0")

  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        license: plugin.license,
        source: "@lyrashield/agent-plugin",
        generatedFiles: GENERATED_FILES,
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
