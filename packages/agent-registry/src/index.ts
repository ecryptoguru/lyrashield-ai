export * from "./types.js"
export * from "./schema.js"
export * from "./render.js"
export * from "./agents.js"

import { AGENTS } from "./agents.js"
import type { AgentEntry, InstallStrategy } from "./types.js"

export function getAgent(id: string): AgentEntry | undefined {
  return AGENTS.find((a) => a.id === id)
}

export function listAgents(): readonly AgentEntry[] {
  return AGENTS
}

export function agentsByStrategy(strategy: InstallStrategy): readonly AgentEntry[] {
  return AGENTS.filter((a) => a.installStrategy === strategy)
}
