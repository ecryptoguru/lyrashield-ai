/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { renderMarkdownBody } from "@lyrashield/agent-rules/renderers/shared.js"
import { LYRASHIELD_POLICY } from "@lyrashield/agent-rules/policy.js"
import { getPluginDir } from "./index.js"

const CLIENTS = ["claude", "cursor", "codex", "kiro"] as const

export async function buildPlugin(): Promise<void> {
  const pluginRoot = getPluginDir()
  const skillDir = path.join(pluginRoot, "skills", "lyrashield")
  await mkdir(skillDir, { recursive: true })

  const skillBody = `---
name: lyrashield
description: Run LyraShield security scans, review findings, and drive the fix → verify loop.
---

${renderMarkdownBody(LYRASHIELD_POLICY, 2)}
`
  await writeFile(path.join(skillDir, "SKILL.md"), skillBody, "utf-8")

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf-8"))

  for (const client of CLIENTS) {
    const shimDir = path.join(pluginRoot, `.${client}-plugin`)
    await mkdir(shimDir, { recursive: true })
    const clientManifest =
      client === "claude"
        ? {
            ...manifest,
            $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
            mcpServers: "./.mcp.json",
          }
        : client === "codex"
          ? (() => {
              const openAiManifest = { ...manifest }
              delete openAiManifest.$schema
              const { name, version, description, ...metadata } = openAiManifest
              return {
                name,
                version,
                description,
                skills: "./skills/",
                mcpServers: "./.mcp.json",
                ...metadata,
              }
            })()
          : manifest
    await writeFile(
      path.join(shimDir, "plugin.json"),
      JSON.stringify(clientManifest, null, 2),
      "utf-8"
    )
  }
}
