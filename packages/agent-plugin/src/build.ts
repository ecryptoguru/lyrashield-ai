/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile, mkdir, readFile, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { renderMarkdownBody } from "@lyrashield/agent-rules/renderers/shared.js"
import { LYRASHIELD_POLICY } from "@lyrashield/agent-rules/policy.js"
import { getPluginDir } from "./index.js"

const CLIENTS = ["claude", "cursor", "codex", "kiro"] as const

const LYRASHIELD_API_URL = "https://app.lyrashieldai.com"

async function writeGeneratedFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, "utf-8")
  await rename(temporary, file)
}

const SKILL_APPENDIX = `## Review-depth guide

Deeper modes consume more compute and take longer. Choose the least intensive goal and mode that answer the user's request.

| User intent | Goal | Mode | When to use |
| --- | --- | --- | --- |
| "Check this diff before I commit" / "Pre-PR check" | CHECK_PR | QUICK | Fast, bounded release review. Use STANDARD only if the user asks for a thorough pre-PR review. |
| "Quick check" / "Is this file safe?" | TEST_APP | QUICK | Fastest bounded repository scan. |
| "Review this repo" / "Standard security review" | TEST_APP | STANDARD | General code review. This is the default for general review. |
| "Launch review" / "Ready to ship?" | LAUNCH_REVIEW | STANDARD | Launch gating. |
| "Repository pentest" / "Deep security review" | FULL_PENTEST | DEEP | Intrusive agentic testing inside the authorized isolated repository sandbox. Never reinterpret this as permission to attack a live URL or API. |
| "Compliance review" | COMPLIANCE_REVIEW | DEEP | Compliance / audit use case. |
| "Weekly monitor" / "Re-check this" | WEEKLY_MONITOR | QUICK | Recurring lightweight check. |

If the user does not specify a mode, default to QUICK for pre-PR checks and STANDARD for general reviews. Only use DEEP when the user asks for a deep or compliance review.

## Example prompts and tool calls

Use these as a guide for common user requests:

- "Check this diff before I commit" → Run \`lyrashield_check_diff\` on the diff. If it reports issues, or the user asks for a full recorded scan, run \`lyrashield_run_pr_scan\` with goal \`CHECK_PR\` and mode \`QUICK\`.
- "Scan this repo" / "Review this project" → Resolve the current/default target, then run \`lyrashield_scan_target\` with goal \`TEST_APP\` and mode \`STANDARD\`.
- "Run a launch review" → Run \`lyrashield_scan_target\` with goal \`LAUNCH_REVIEW\` and mode \`STANDARD\`.
- "Repository pentest" / "Deep security review" → For an authorized repository target, run \`lyrashield_scan_target\` with goal \`FULL_PENTEST\` and mode \`DEEP\`. For URL/API targets, explain that Deep is non-mutating behavioral review, not live exploit testing.
- "Explain finding f-123" → Run \`lyrashield_explain_finding\` with the finding ID.
- "How do I fix this?" → Run \`lyrashield_generate_fix_plan\` with the finding ID.
- "I applied the fix" → Run \`lyrashield_verify_fix\` with the finding ID, poll the returned retest scan to a terminal state, and include its outcome and scan reference in the PR. Call it independently verified only when a separate independent-verification receipt exists.
- "Summarize security for this PR" → Run \`lyrashield_create_pr_security_recap\`.

## Depth and runtime awareness

Deeper modes consume more compute and take longer. Choose the least intensive mode that answers the user's question. Do not run DEEP scans for quick checks, and avoid re-running the same scan repeatedly. When in doubt, ask the user which depth they want.
`

export async function buildPlugin(): Promise<void> {
  const pluginRoot = getPluginDir()
  const skillDir = path.join(pluginRoot, "skills", "lyrashield")
  await mkdir(skillDir, { recursive: true })

  const skillBody = `---
name: lyrashield
description: Run LyraShield security scans, review findings, and drive the fix → verify loop.
---

${renderMarkdownBody(LYRASHIELD_POLICY, 2)}

${SKILL_APPENDIX}
`

  await writeGeneratedFile(path.join(skillDir, "SKILL.md"), skillBody.replace(/\n+\s*$/, "\n"))

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf-8"))

  // Kiro loads local stdio MCP config from a separate file. Authentication stays
  // in the user-only credential store rather than the plugin manifest.
  await writeGeneratedFile(
    path.join(pluginRoot, ".mcp.kiro.json"),
    JSON.stringify(
      {
        mcpServers: {
          lyrashield: {
            command: "npx",
            args: ["-y", "@lyrashield/mcp"],
            env: {
              LYRASHIELD_API_URL,
            },
          },
        },
      },
      null,
      2
    )
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
    await writeGeneratedFile(
      path.join(shimDir, "plugin.json"),
      JSON.stringify(clientManifest, null, 2)
    )
  }
}

if (import.meta.main) {
  await buildPlugin()
}
