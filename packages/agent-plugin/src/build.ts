/* eslint-disable security/detect-non-literal-fs-filename */
import { writeFile, mkdir, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { renderMarkdownBody } from "@lyrashield/agent-rules/renderers/shared.js"
import { LYRASHIELD_POLICY } from "@lyrashield/agent-rules/policy.js"
import { getPluginDir } from "./plugin-dir.js"

const CLIENTS = ["claude", "cursor", "codex", "kiro"] as const

const LYRASHIELD_API_URL = "https://app.lyrashieldai.com"
const OPENAI_ICON_RELATIVE_PATH = "./assets/lyrashield-400.png"

type PluginManifest = {
  extensions?: Record<string, { interface?: Record<string, unknown> }>
}

export interface BuildPluginOptions {
  /** Optional isolated tree for consumers that need generated output without mutating source. */
  pluginRoot?: string
  /** Explicit owned icon path when building an isolated plugin tree. */
  logoAssetPath?: string
}

// Marketplace identifier users type when installing: `/plugin install lyrashield@lyrashield-ai`.
// Kept distinct from the plugin name ("lyrashield") so the two are unambiguous in install strings.
const MARKETPLACE_NAME = "lyrashield-ai"

async function writeGeneratedFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, "utf-8")
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function writeGeneratedAsset(file: string, content: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function prepareOpenAiAssets(
  pluginRoot: string,
  manifest: PluginManifest,
  logoAssetPath?: string
): Promise<void> {
  const openAiInterface = manifest.extensions?.["com.openai"]?.interface
  if (!openAiInterface) return

  const destination = resolvePluginAsset(pluginRoot, OPENAI_ICON_RELATIVE_PATH)
  if (!destination) {
    throw new Error("OpenAI icon path must remain inside the plugin root")
  }

  let image: Buffer
  if (logoAssetPath !== undefined) {
    image = await readFile(logoAssetPath)
  } else {
    const source = path.resolve(pluginRoot, "../../../docs/marketplace/assets/lyrashield-400.png")
    try {
      image = await readFile(source)
    } catch (error) {
      const isMissingSource =
        error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
      if (!isMissingSource) throw error
      // Published package trees contain their owned icon, while the canonical docs asset only
      // exists in the source checkout. Fall back only when that default lookup is absent.
      image = await readFile(destination)
    }
  }
  const isPng =
    image.length >= 24 &&
    image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = isPng ? image.readUInt32BE(16) : 0
  const height = isPng ? image.readUInt32BE(20) : 0
  if (!isPng || width !== 400 || height !== 400) {
    throw new Error("OpenAI logo and composer icon must resolve to the owned 400 x 400 PNG asset")
  }

  await mkdir(path.dirname(destination), { recursive: true })
  await writeGeneratedAsset(destination, image)

  for (const key of ["logo", "composerIcon"] as const) {
    const configuredPath = openAiInterface[key]
    if (configuredPath !== OPENAI_ICON_RELATIVE_PATH) {
      throw new Error(`OpenAI ${key} must reference ${OPENAI_ICON_RELATIVE_PATH}`)
    }
    if (!resolvePluginAsset(pluginRoot, configuredPath)) {
      throw new Error(`OpenAI ${key} path must remain inside the plugin root`)
    }
  }
}

function resolvePluginAsset(pluginRoot: string, configuredPath: unknown): string | null {
  if (typeof configuredPath !== "string" || path.isAbsolute(configuredPath)) return null
  const resolvedPath = path.resolve(pluginRoot, configuredPath)
  const relativePath = path.relative(pluginRoot, resolvedPath)
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null
  }
  return resolvedPath
}

const SKILL_APPENDIX = `## Review-depth guide

Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge.

Use a stable idempotency key for each intended mutating action and reuse it for identical retries.
Reuse a returned scan or operation ID instead of starting another action. For findings, follow
nextCursor with lyrashield_get_findings(cursor=...) until it is absent; a partial page is
not a complete review. Poll scan and operation status starting at five seconds, back off up to
30 seconds, stop on a terminal state and return the resumable ID after a bounded session.
Treat failed, cancelled, inconclusive and insufficient-evidence states explicitly.

Deeper modes consume more compute and take longer. Choose the least intensive goal and mode that answer the user's request.

| User intent | Goal | Mode | When to use |
| --- | --- | --- | --- |
| "Check this diff before I commit" / "Pre-PR check" | CHECK_PR | QUICK | Fast, bounded release review. Use STANDARD only if the user asks for a thorough pre-PR review. |
| "Quick check" / "Is this file safe?" | TEST_APP | QUICK | Fastest bounded repository scan. |
| "Review this repo" / "Standard security review" | TEST_APP | STANDARD | General code review. This is the default for general review. |
| "Launch review" / "Ready to ship?" | LAUNCH_REVIEW | STANDARD | Launch gating. |
| "Repository pentest" / "Deep security scan" | FULL_PENTEST | DEEP | Intrusive agentic testing inside the authorized isolated repository sandbox. Never reinterpret this as permission to attack a live URL or API. |
| "Compliance review" | COMPLIANCE_REVIEW | DEEP | Compliance / audit use case. |
| "Weekly monitor" / "Re-check this" | WEEKLY_MONITOR | QUICK | Recurring lightweight check. |

If the user does not specify a mode, default to QUICK for pre-PR checks and STANDARD for general reviews. Only use DEEP when the user asks for a deep or compliance review.

## Example prompts and tool calls

Match the workflow to the user's explicit request:

- A question about connecting or access: use \`lyrashield_list_workspaces\` and \`lyrashield_list_targets\` only.
- "Check this diff" / "Review my changes": use the read-only advisory \`lyrashield_check_diff\`; it is not a recorded scan.
- "Run a Quick scan" / "Scan this project": use \`lyrashield_get_scan_eligibility\` as an advisory preflight, then \`lyrashield_scan_target\` or \`lyrashield_run_pr_scan\` only when requested.
- "Explain this finding" / "How should I fix it?": use \`lyrashield_explain_finding\` and \`lyrashield_generate_fix_plan\` with the selected workspace and finding.
- "I applied the fix": use \`lyrashield_verify_fix\` with \`workspaceId\` and \`findingId\`, poll the returned retest scan to a terminal state, and include its outcome and scan reference. Call it independently verified only when a separate independent-verification receipt exists.
- "Is this target ready to ship?": use \`lyrashield_get_launch_readiness\` for the selected workspace and target, bound to the supplied commit or artifact digest when available.

Read the connected client's current tool schema before building arguments. Tool availability can differ by client; never invent an operation or field, and never replace a missing tool with a guessed API call.

## Depth and runtime awareness

Deeper modes consume more compute and take longer. Choose the least intensive mode that answers the user's question. Do not run DEEP scans for quick checks, and avoid re-running the same scan repeatedly. When in doubt, ask the user which depth they want.
`

const WORKFLOW_SKILLS = [
  {
    name: "get-started",
    description: "Connect LyraShield, choose a workspace and inspect authorized targets.",
    instructions: `# Get started

Use this workflow when the user asks to connect LyraShield, check access or find a target.

1. Call \`lyrashield_list_workspaces\` and let the user choose a workspace unless the active client already supplies one and a LyraShield response confirms it.
2. Call \`lyrashield_list_targets\` with the selected \`workspaceId\`. Follow \`nextCursor\` with \`cursor\` until it is absent before claiming the target list is complete.
3. Use only a target returned for that workspace. Explain that configuration on disk does not prove the client loaded the server; verify with the client's MCP status or tool list.
4. Explain hosted OAuth and local stdio/API-key options using the client’s current setup instructions. Never request, print or store a secret in a shared config file.

This workflow is read-only. Do not start scans or change target, workspace, billing or authorization state.`,
  },
  {
    name: "review-changes",
    description: "Review the current diff with LyraShield's read-only advisory check.",
    instructions: `# Review changes

Use this skill when the user asks for a review of staged or current code changes.

1. Read the requested diff from the working tree. Use \`git diff --cached\` for staged-only changes or \`git diff HEAD\` for the full working-tree change set.
2. Call \`lyrashield_check_diff\` with its required \`diff\` field. Add \`files\` only when full-file snapshots are available and fit the tool's current limits.
3. Describe results as advisory heuristics. Preserve the returned coverage state; an incomplete advisory check is not a recorded scan and does not establish that the code is secure.
4. Start a recorded Quick scan with \`lyrashield_run_pr_scan\` only when the user explicitly requests one, and only after resolving the authorized workspace and target. Create and retain one unique \`idempotencyKey\` for this intended scan and reuse it for identical retries. Do not start one because an advisory finding appeared.

If no diff is available, report that and ask for the intended files or range. Never invent diff content.`,
  },
  {
    name: "scan-project",
    description: "Start an explicitly requested scan on an authorized LyraShield target.",
    instructions: `# Scan a project

Start a recorded scan only when the user asks for one.

1. Resolve the selected \`workspaceId\` and an authorized \`targetId\` using \`lyrashield_list_workspaces\` and \`lyrashield_list_targets\` when needed.
2. Call \`lyrashield_get_scan_eligibility\` as a read-only advisory preflight. A pass does not guarantee that scan creation will be admitted; the server checks again.
3. Use the least intensive requested profile: QUICK for an ordinary pre-PR check, STANDARD for a general review and DEEP only when the user explicitly requests it and the selected target/profile permits it. Set the intended goal and mode explicitly.
4. Call \`lyrashield_scan_target\` or the PR-specific \`lyrashield_run_pr_scan\` using only fields in the current tool schema. Create and retain one unique \`idempotencyKey\` for this intended action and reuse it for identical retries. Use a new key only for a separately requested scan.
5. Save the returned \`scanId\` or \`operationId\`. Poll \`lyrashield_get_scan_status\` with exactly one identifier, starting after 2 seconds and doubling the delay up to 30 seconds. Stop at a terminal state or after 20 checks. If the session or polling limit ends first, return the resumable identifier and resume it later instead of starting a replacement scan.

Never scan a guessed, third-party or unapproved target. Report failed, cancelled, inconclusive and insufficient-evidence outcomes explicitly.`,
  },
  {
    name: "fix-and-retest",
    description: "Review finding evidence, prepare a fix proposal and verify an applied fix.",
    instructions: `# Fix and retest

1. Retrieve findings with \`lyrashield_get_findings\` in the selected workspace. Follow every \`nextCursor\` with \`cursor\` before claiming the result set is complete.
2. Use \`lyrashield_explain_finding\` and \`lyrashield_generate_fix_plan\` with the selected workspace and finding ID. Keep detection, confidence and verification states distinct.
3. Treat a generated plan as a proposal. Persist one with \`lyrashield_record_fix_proposal\` only when the user asks to record it; never treat a proposal as a verified fix. Create and retain one unique \`idempotencyKey\` for recording the proposal and reuse it for identical retries.
4. After the user confirms that a fix was applied, call \`lyrashield_verify_fix\` with \`workspaceId\` and \`findingId\`. Create and retain a separate unique \`idempotencyKey\` for this retest and reuse it for identical retries.
5. Retain the returned retest scan identifier. Poll \`lyrashield_get_scan_status\`, starting after 2 seconds and doubling the delay up to 30 seconds, for at most 20 checks or until terminal. Return the identifier if polling or the session ends first and resume that retest later. Preserve \`FIXED_PENDING_RETEST\`, \`DETECTED\`, \`INCONCLUSIVE\` and \`INSUFFICIENT_EVIDENCE\` exactly as reported. Claim validation only when the trusted retest evidence establishes it.

Do not create a pull request, merge or deploy unless the user separately requests that action and the server-authorized workflow supports it.`,
  },
  {
    name: "launch-readiness",
    description: "Read LyraShield release readiness evidence and explain missing gates.",
    instructions: `# Launch readiness

Use this workflow only when the user asks whether a registered target is ready for a release.

1. Resolve the selected workspace and authorized target. Call \`lyrashield_get_launch_readiness\` with \`workspaceId\` and \`targetId\`.
2. Bind the query to the supplied release commit or artifact digest when available. A readiness result is enforceable only when it matches the release identity.
3. Explain each returned gate and evidence state. Identify missing or stale evidence as unresolved; do not fill gaps from assumptions or a clean advisory diff.
4. Keep operational readiness separate from a security guarantee, certification, compliance claim or proof that every vulnerability was detected.

This workflow is read-only. It does not start a scan, deploy an artifact or change a release gate.`,
  },
] as const

function renderWorkflowSkill(skill: (typeof WORKFLOW_SKILLS)[number]): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions.trim()}\n`
}

export async function buildPlugin({
  pluginRoot = getPluginDir(),
  logoAssetPath,
}: BuildPluginOptions = {}): Promise<void> {
  const skillDir = path.join(pluginRoot, "skills", "lyrashield")
  await mkdir(skillDir, { recursive: true })

  const skillBody = `---
name: lyrashield
description: Run LyraShield security scans, review findings and drive the fix → verify loop.
---

${renderMarkdownBody(LYRASHIELD_POLICY, 2)}

${SKILL_APPENDIX}
`

  await writeGeneratedFile(path.join(skillDir, "SKILL.md"), skillBody.replace(/\n+\s*$/, "\n"))
  for (const skill of WORKFLOW_SKILLS) {
    const content = renderWorkflowSkill(skill)
    await mkdir(path.join(pluginRoot, "skills", skill.name), { recursive: true })
    await writeGeneratedFile(path.join(pluginRoot, "skills", skill.name, "SKILL.md"), content)
  }

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf-8"))
  await prepareOpenAiAssets(pluginRoot, manifest as PluginManifest, logoAssetPath)

  const vendorManifest = () => {
    const result = { ...manifest }
    if (result.extensions && typeof result.extensions === "object") {
      const otherExtensions = Object.fromEntries(
        Object.entries(result.extensions).filter(([extension]) => extension !== "com.openai")
      )
      if (Object.keys(otherExtensions).length > 0) result.extensions = otherExtensions
      else delete result.extensions
    }
    return result
  }

  // Agent Plugins 1.0 uses `streamable-http`; vendor shims below keep each
  // client's own transport spelling.
  await writeGeneratedFile(
    path.join(pluginRoot, "mcp.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          lyrashield: {
            type: "streamable-http",
            url: `${LYRASHIELD_API_URL}/api/mcp`,
          },
        },
      },
      null,
      2
    )
  )

  // Kiro loads local stdio MCP config from a separate file. Authentication stays
  // in the user-only credential store rather than the plugin manifest.
  await writeGeneratedFile(
    path.join(pluginRoot, ".mcp.kiro.json"),
    JSON.stringify(
      {
        mcpServers: {
          lyrashield: {
            command: "npx",
            args: ["-y", "@lyrashield/mcp@0.2.12"],
          },
        },
      },
      null,
      2
    )
  )

  // Codex accepts a direct server map (or a wrapped `mcp_servers` map), not the
  // Agent Plugins `mcpServers` envelope used by the portable descriptor.
  await writeGeneratedFile(
    path.join(pluginRoot, ".mcp.codex.json"),
    JSON.stringify(
      {
        lyrashield: {
          url: `${LYRASHIELD_API_URL}/api/mcp`,
        },
      },
      null,
      2
    )
  )

  // Codex installs from its own compatibility root. Its manifest points to the
  // Codex-format `.mcp.json` there, separate from the portable root MCP envelope.
  const codexRoot = path.join(pluginRoot, "codex-plugin")
  await mkdir(path.join(codexRoot, ".codex-plugin"), { recursive: true })
  await mkdir(path.join(codexRoot, "skills", "lyrashield"), { recursive: true })
  await writeGeneratedFile(
    path.join(codexRoot, "skills", "lyrashield", "SKILL.md"),
    skillBody.replace(/\n+\s*$/, "\n")
  )
  for (const skill of WORKFLOW_SKILLS) {
    await mkdir(path.join(codexRoot, "skills", skill.name), { recursive: true })
    await writeGeneratedFile(
      path.join(codexRoot, "skills", skill.name, "SKILL.md"),
      renderWorkflowSkill(skill)
    )
  }
  await writeGeneratedFile(
    path.join(codexRoot, ".mcp.json"),
    JSON.stringify(
      {
        lyrashield: {
          type: "streamable-http",
          url: `${LYRASHIELD_API_URL}/api/mcp`,
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
            ...vendorManifest(),
            $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
            mcpServers: "./.mcp.json",
          }
        : client === "codex"
          ? (() => {
              const openAiManifest = { ...manifest }
              delete openAiManifest.$schema
              const { name, version, description, extensions, ...metadata } = openAiManifest
              const openAi = extensions?.["com.openai"] ?? {}
              const { interface: openAiInterface, ...openAiReviewAndPublication } = openAi
              const codexExtensions = { ...extensions }
              delete codexExtensions["com.openai"]
              if (Object.keys(openAiReviewAndPublication).length > 0) {
                codexExtensions["com.openai"] = openAiReviewAndPublication
              }
              return {
                name,
                version,
                description,
                ...(openAiInterface ? { interface: openAiInterface } : {}),
                skills: "./skills/",
                mcpServers: "./.mcp.codex.json",
                ...metadata,
                ...(Object.keys(codexExtensions).length > 0 ? { extensions: codexExtensions } : {}),
              }
            })()
          : client === "cursor"
            ? (() => {
                const cursorManifest = vendorManifest()
                delete cursorManifest.$schema
                return {
                  ...cursorManifest,
                  mcpServers: {
                    lyrashield: {
                      type: "http",
                      url: `${LYRASHIELD_API_URL}/api/mcp`,
                    },
                  },
                }
              })()
            : (() => {
                const kiroManifest = vendorManifest()
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

  await writeGeneratedFile(
    path.join(codexRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        ...JSON.parse(
          await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf-8")
        ),
        mcpServers: "./.mcp.json",
      },
      null,
      2
    )
  )

  const codexMarketplaceDir = path.join(pluginRoot, ".agents", "plugins")
  await mkdir(codexMarketplaceDir, { recursive: true })
  await writeGeneratedFile(
    path.join(codexMarketplaceDir, "marketplace.json"),
    JSON.stringify(
      {
        name: MARKETPLACE_NAME,
        interface: { displayName: "LyraShield AI" },
        plugins: [
          {
            name: manifest.name,
            version: manifest.version,
            source: { source: "local", path: "./codex-plugin" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Security",
          },
        ],
      },
      null,
      2
    )
  )

  // Marketplace catalog. This is what turns the exported repository into an addressable
  // plugin marketplace (`/plugin marketplace add`, and VS Code's "Install Plugin From
  // Source") rather than a bare plugin directory. The catalog is a Claude Code format;
  // Agent Plugins 1.0 deliberately leaves distribution to clients, and VS Code documents
  // this same file as the marketplace schema it consumes.
  //
  // `source: "./"` points at the marketplace root, which is the directory containing
  // `.claude-plugin/` — i.e. the exported repository root, where plugin.json already lives.
  const marketplaceDir = path.join(pluginRoot, ".claude-plugin")
  await mkdir(marketplaceDir, { recursive: true })
  await writeGeneratedFile(
    path.join(marketplaceDir, "marketplace.json"),
    JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-marketplace.json",
        name: MARKETPLACE_NAME,
        version: manifest.version,
        description: "LyraShield AI security and release-assurance plugin for AI coding agents",
        owner: {
          name: "LyraShield AI",
          url: "https://lyrashieldai.com",
        },
        plugins: [
          {
            name: manifest.name,
            source: "./",
            description: manifest.description,
            version: manifest.version,
            author: manifest.author,
            homepage: manifest.homepage,
            repository: manifest.repository,
            license: manifest.license,
            keywords: manifest.keywords,
            category: "security",
          },
        ],
      },
      null,
      2
    )
  )
}

if (import.meta.main) {
  await buildPlugin()
}
