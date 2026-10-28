import { logger } from "@lyrashield/logger"
import { findOldestTerminalUnreconciledCost } from "./operational-health"

const TERMINAL_COST_HEALTH_INTERVAL_MS = 5 * 60_000

type TerminalCostObservation = {
  code: "terminal_cost_unreconciled"
  observedAt: string
} & ({ state: "healthy" | "unknown" } | { state: "unhealthy"; scanId: string; ageMs: number })

export async function sampleTerminalCostHealth(now = new Date()): Promise<TerminalCostObservation> {
  const base = { code: "terminal_cost_unreconciled" as const, observedAt: now.toISOString() }
  let observation: TerminalCostObservation
  try {
    const oldest = await findOldestTerminalUnreconciledCost(now)
    if (!oldest) {
      observation = { ...base, state: "healthy" }
    } else if (
      /^c[a-z0-9]{24}$/.test(oldest.id) &&
      oldest.endedAt &&
      Number.isFinite(oldest.endedAt.getTime())
    ) {
      observation = {
        ...base,
        state: "unhealthy",
        scanId: oldest.id,
        ageMs: now.getTime() - oldest.endedAt.getTime(),
      }
    } else {
      observation = { ...base, state: "unknown" }
    }
  } catch {
    observation = { ...base, state: "unknown" }
  }
  if (observation.state === "healthy") logger.info("operational_health_sample", observation)
  else logger.warn("operational_health_sample", observation)
  return observation
}

export function startTerminalCostHealthSampler(): NodeJS.Timeout {
  let sampling = false
  const tick = async () => {
    if (sampling) return
    sampling = true
    try {
      await sampleTerminalCostHealth()
    } finally {
      sampling = false
    }
  }
  void tick()
  return setInterval(() => {
    void tick()
  }, TERMINAL_COST_HEALTH_INTERVAL_MS)
}
