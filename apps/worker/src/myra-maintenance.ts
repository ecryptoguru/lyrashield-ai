/** Periodic recovery and retention for durable Myra state. */
import { pruneMyraRetention } from "@lyrashield/myra/server"
import { logger } from "@lyrashield/logger"

const MYRA_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000

export async function runMyraMaintenance(): Promise<void> {
  const counts = await pruneMyraRetention()
  if (Object.values(counts).some((count) => count > 0)) {
    logger.info("Myra maintenance sweep completed", { ...counts })
  }
}

export function startMyraMaintenanceRunner(
  intervalMs = MYRA_MAINTENANCE_INTERVAL_MS
): NodeJS.Timeout {
  const run = () => {
    void runMyraMaintenance().catch((error) => {
      logger.error("Myra maintenance sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  run()
  const timer = setInterval(run, intervalMs)
  logger.info("Myra maintenance runner started", { intervalMs })
  return timer
}
