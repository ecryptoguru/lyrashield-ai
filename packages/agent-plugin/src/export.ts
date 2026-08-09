/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildPlugin } from "./build.js"
import { getPluginDir } from "./index.js"

const APACHE_2_LICENSE = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`

const PUBLIC_FILES = [
  "README.md",
  "CHANGELOG.md",
  "plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/skills",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".kiro-plugin/plugin.json",
  ".mcp.json",
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
] as const

/** Export only installable client artifacts; hosted service code never crosses this boundary. */
export async function exportMarketplace(destination: string): Promise<void> {
  const pluginRoot = getPluginDir()
  const repoRoot = path.resolve(pluginRoot, "../../..")
  const marketplaceDocs = path.join(repoRoot, "docs", "marketplace")
  await buildPlugin()
  await mkdir(destination, { recursive: true })

  for (const relative of PUBLIC_FILES) {
    const sourceRelative = relative.startsWith("plugin/")
      ? relative.slice("plugin/".length)
      : relative
    const source =
      relative === "README.md" || relative === "CHANGELOG.md"
        ? path.join(marketplaceDocs, relative)
        : path.join(pluginRoot, sourceRelative)
    await cp(source, path.join(destination, relative), {
      recursive: true,
      force: true,
    })
  }
  // Claude Code loads skills and MCP configuration only from the plugin root.
  await cp(path.join(pluginRoot, "skills"), path.join(destination, "skills"), {
    recursive: true,
    force: true,
  })
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
  await cp(path.join(pluginRoot, "plugin.json"), path.join(destination, "plugin.json"), {
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

  await writeFile(path.join(destination, "LICENSE"), APACHE_2_LICENSE, "utf8")
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        license: plugin.license,
        source: "@lyrashield/agent-plugin",
        generatedFiles: [...PUBLIC_FILES, "skills", ...MARKETPLACE_ARTIFACTS],
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
