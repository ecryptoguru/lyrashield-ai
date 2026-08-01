import { createHash } from "node:crypto"
import type { AgentEntry } from "@lyrashield/agent-registry"
import type { Policy, RenderRuleOptions, RuleFile, RuleFormat, RuleFormatInfo } from "../types.js"
import { LYRASHIELD_POLICY } from "../policy.js"
import { renderClaudeCode } from "./claude-code.js"
import { renderAgentsMd } from "./agents-md.js"
import { renderCursor } from "./cursor.js"
import { renderCopilot } from "./copilot.js"
import { renderWindsurf } from "./windsurf.js"
import { renderCline } from "./cline.js"
import { renderOpenClaw } from "./openclaw.js"
import { defaultRulePath } from "./shared.js"

const RENDERERS: Record<RuleFormat, (policy: Policy, opts: RenderRuleOptions) => string> = {
  "claude-code": renderClaudeCode,
  "agents-md": renderAgentsMd,
  cursor: renderCursor,
  copilot: renderCopilot,
  windsurf: renderWindsurf,
  cline: renderCline,
  openclaw: renderOpenClaw,
}

export function listRuleFormats(): RuleFormatInfo[] {
  return [
    { format: "claude-code", label: "Claude Code", defaultFiles: ["CLAUDE.md"] },
    { format: "agents-md", label: "AGENTS.md", defaultFiles: ["AGENTS.md"] },
    {
      format: "cursor",
      label: "Cursor",
      defaultFiles: [".cursor/rules/lyrashield.mdc", ".cursorrules"],
    },
    {
      format: "copilot",
      label: "GitHub Copilot",
      defaultFiles: [".github/copilot-instructions.md"],
    },
    { format: "windsurf", label: "Windsurf", defaultFiles: [".windsurf/rules/lyrashield.md"] },
    { format: "cline", label: "Cline", defaultFiles: [".clinerules"] },
    { format: "openclaw", label: "OpenClaw", defaultFiles: ["skills/lyrashield/skill.md"] },
  ]
}

export function formatForRulesFile(rulesFile: string): RuleFormat | undefined {
  const lower = rulesFile.toLowerCase()
  if (lower === "claude.md") return "claude-code"
  if (lower === "agents.md") return "agents-md"
  // Antigravity (GEMINI.md) and Goose (.goosehints) are plain markdown rules /
  // hints files; render them with the generic AGENTS.md markdown body.
  if (lower === "gemini.md") return "agents-md"
  if (lower === ".goosehints") return "agents-md"
  if (lower === ".cursorrules") return "cursor"
  if (lower.includes("lyrashield.mdc")) return "cursor"
  if (lower.includes("copilot-instructions.md")) return "copilot"
  if (lower.includes("lyrashield.md") && lower.includes(".windsurf")) return "windsurf"
  if (lower === ".clinerules") return "cline"
  if (lower.includes("skill.md")) return "openclaw"
  return undefined
}

export function resolveRuleFilePath(rulesFile: string): string {
  const lower = rulesFile.toLowerCase()
  if (lower.includes("openclaw") && lower.includes("skill.md")) {
    return "skills/lyrashield/skill.md"
  }
  return rulesFile
}

export function renderRuleForAgent(
  agent: AgentEntry,
  rulesFile: string,
  policyVersion?: string
): RuleFile {
  const format = formatForRulesFile(rulesFile)
  if (!format) {
    throw new Error(`No rule renderer for agent ${agent.id} file ${rulesFile}`)
  }
  const file = resolveRuleFilePath(rulesFile)
  return renderRule({
    format,
    file,
    agentId: agent.id,
    agentDisplayName: agent.displayName,
    policyVersion,
  })
}

export function renderRule(opts: RenderRuleOptions): RuleFile {
  const renderer = RENDERERS[opts.format]
  if (!renderer) {
    throw new Error(`Unknown rule format: ${opts.format}`)
  }

  const file = opts.file ?? defaultRulePath(opts.format)
  const agentDisplayName = opts.agentDisplayName ?? opts.agentId
  const policyVersion = opts.policyVersion ?? LYRASHIELD_POLICY.version

  const inner = renderer(LYRASHIELD_POLICY, {
    ...opts,
    file,
    agentDisplayName,
    policyVersion,
  })

  const body = `\n${inner}\n`
  const sha = createHash("sha256").update(body).digest("hex").slice(0, 12)
  const begin = `<!-- lyrashield:begin v=${policyVersion} sha=${sha} -->`
  const end = `<!-- lyrashield:end -->`
  const content = `${begin}${body}${end}\n`

  return {
    format: opts.format,
    file,
    agentId: opts.agentId,
    agentDisplayName,
    policyVersion,
    inner,
    content,
    sha,
  }
}
