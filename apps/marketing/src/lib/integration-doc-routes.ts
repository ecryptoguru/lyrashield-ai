import { listPreferredAgents } from "@lyrashield/agent-registry"
import type { RegistryAgentEntry } from "@lyrashield/agent-registry"

/** Client guides with authored pages. New registry slugs use the generated guide. */
export const EXPLICIT_INTEGRATION_DOC_SLUGS = [
  "aider",
  "amp",
  "antigravity",
  "claude-code",
  "cline",
  "codebuff",
  "copilot-cli",
  "cursor",
  "devin",
  "devin-cli",
  "gemini-cli",
  "github-copilot",
  "goose",
  "hermes",
  "jetbrains",
  "kilo-code",
  "kiro",
  "mimo-code",
  "oh-my-pi",
  "openai-codex",
  "openclaw",
  "opencode",
  "roo-code",
  "vscode",
  "zed",
] as const

const explicitSlugs = new Set<string>(EXPLICIT_INTEGRATION_DOC_SLUGS)

/** Every preferred registry slug without an authored Astro page gets a guide. */
export function listGeneratedIntegrationDocs(): RegistryAgentEntry[] {
  const bySlug = new Map<string, RegistryAgentEntry>()
  // Registry entries are normalized to this shape by AGENTS; the selector's
  // public return type remains the smaller authored-entry type.
  for (const agent of listPreferredAgents() as readonly RegistryAgentEntry[]) {
    if (!explicitSlugs.has(agent.docsSlug) && !bySlug.has(agent.docsSlug)) {
      bySlug.set(agent.docsSlug, agent)
    }
  }
  return [...bySlug.values()]
}
