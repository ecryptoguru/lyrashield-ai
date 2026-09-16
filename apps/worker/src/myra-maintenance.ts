/** Periodic recovery and retention for durable Myra state. */
import { pruneMyraRetention, recoverMyraState } from "@lyrashield/myra/server"
import { logger } from "@lyrashield/logger"

// The recovery pass unblocks wedged user-facing state, so it keeps a short
// cadence. The retention sweep scans whole tables; thirty minutes is enough.
const MYRA_RECOVERY_INTERVAL_MS = 5 * 60 * 1000
const MYRA_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000

export async function runMyraRecovery(): Promise<void> {
  const counts = await recoverMyraState()
  if (Object.values(counts).some((count) => count > 0)) {
    logger.info("Myra recovery sweep completed", { ...counts })
  }
}

export async function runMyraMaintenance(): Promise<void> {
  const counts = await pruneMyraRetention()
  if (Object.values(counts).some((count) => count > 0)) {
    logger.info("Myra maintenance sweep completed", { ...counts })
  }
}

function startRunner(label: string, run: () => Promise<void>, intervalMs: number): NodeJS.Timeout {
  const tick = () => {
    void run().catch((error) => {
      logger.error(`${label} failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  logger.info(`${label} started`, { intervalMs })
  return timer
}

export function startMyraRecoveryRunner(intervalMs = MYRA_RECOVERY_INTERVAL_MS): NodeJS.Timeout {
  return startRunner("Myra recovery sweep", runMyraRecovery, intervalMs)
}

export function startMyraMaintenanceRunner(
  intervalMs = MYRA_MAINTENANCE_INTERVAL_MS
): NodeJS.Timeout {
  return startRunner("Myra maintenance sweep", runMyraMaintenance, intervalMs)
}
