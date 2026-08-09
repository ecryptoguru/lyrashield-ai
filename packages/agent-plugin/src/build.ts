/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { renderMarkdownBody } from "@lyrashield/agent-rules/renderers/shared.js"
import { LYRASHIELD_POLICY } from "@lyrashield/agent-rules/policy.js"
import { getPluginDir } from "./index.js"

const CLIENTS = ["claude", "cursor", "codex", "kiro"] as const

const LYRASHIELD_API_URL = "https://app.lyrashieldai.com"

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

  // Kiro loads MCP config from a separate file so env expansion works for secrets.
  await writeFile(
    path.join(pluginRoot, ".mcp.kiro.json"),
    JSON.stringify(
      {
        mcpServers: {
          lyrashield: {
            command: "npx",
            args: ["-y", "@lyrashield/mcp"],
            env: {
              LYRASHIELD_API_URL,
              LYRASHIELD_API_KEY: "${LYRASHIELD_API_KEY}",
            },
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )

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
          : client === "cursor"
            ? (() => {
                const cursorManifest = { ...manifest }
                delete cursorManifest.$schema
                return {
                  ...cursorManifest,
                  mcpServers: {
                    lyrashield: {
                      url: `${LYRASHIELD_API_URL}/api/mcp`,
                      headers: {
                        Authorization: "Bearer ${LYRASHIELD_API_KEY}",
                      },
                    },
                  },
                  variables: {
                    LYRASHIELD_API_KEY: {
                      type: "string",
                      description: "API key for the LyraShield MCP server",
                    },
                  },
                }
              })()
            : (() => {
                const kiroManifest = { ...manifest }
                delete kiroManifest.$schema
                return {
                  ...kiroManifest,
                  skills: "./skills/",
                  mcpServers: "./.mcp.kiro.json",
                  kiro: {
                    skills: "./skills/",
                    mcpServers: "./.mcp.kiro.json",
                  },
                }
              })()
    await writeFile(
      path.join(shimDir, "plugin.json"),
      JSON.stringify(clientManifest, null, 2),
      "utf-8"
    )
  }
}
