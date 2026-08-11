export * from "./types"
export * from "./schema"
export * from "./render"
export * from "./agents"

import { AGENTS } from "./agents"
import type { AgentEntry, InstallStrategy } from "./types"

// These clients have a generated, client-specific plugin shim in the public
// marketplace artifact. Their ordinary CLI names should therefore install the
// plugin, while the legacy config entry remains addressable for recovery.
const PREFERRED_PLUGIN_ID_BY_AGENT_ID: Readonly<Record<string, string>> = {
  "claude-code": "claude-code-agent-plugin",
  cursor: "cursor-agent-plugin",
  "openai-codex": "openai-codex-agent-plugin",
}

export function getAgent(id: string): AgentEntry | undefined {
  return AGENTS.find((a) => a.id === id)
}

/** Resolve the one recommended install path without hiding an explicit legacy id. */
export function getPreferredAgent(id: string): AgentEntry | undefined {
  const pluginId = PREFERRED_PLUGIN_ID_BY_AGENT_ID[id]
  return (pluginId ? getAgent(pluginId) : undefined) ?? getAgent(id)
}

export function listAgents(): readonly AgentEntry[] {
  return AGENTS
}

/** One card per documented client: hide legacy/config duplicates from normal UX. */
export function listPreferredAgents(): readonly AgentEntry[] {
  const preferredPluginIds = new Set(Object.values(PREFERRED_PLUGIN_ID_BY_AGENT_ID))
  const preferredBaseIds = new Set(Object.keys(PREFERRED_PLUGIN_ID_BY_AGENT_ID))
  const configDocsSlugs = new Set(
    AGENTS.filter((agent) => agent.installStrategy !== "agent-plugin").map(
      (agent) => agent.docsSlug
    )
  )

  return AGENTS.filter((agent) => {
    if (preferredBaseIds.has(agent.id)) return false
    if (agent.installStrategy !== "agent-plugin") return true
    if (preferredPluginIds.has(agent.id)) return true
    return !configDocsSlugs.has(agent.docsSlug)
  })
}

export function agentsByStrategy(strategy: InstallStrategy): readonly AgentEntry[] {
  return AGENTS.filter((a) => a.installStrategy === strategy)
}
