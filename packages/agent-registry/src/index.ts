export * from "./types"
export * from "./schema"
export * from "./render"
export * from "./agents"

import { AGENTS } from "./agents"
import type { AgentEntry, InstallStrategy } from "./types"

export function getAgent(id: string): AgentEntry | undefined {
  return AGENTS.find((a) => a.id === id)
}

export function listAgents(): readonly AgentEntry[] {
  return AGENTS
}

export function agentsByStrategy(strategy: InstallStrategy): readonly AgentEntry[] {
  return AGENTS.filter((a) => a.installStrategy === strategy)
}
