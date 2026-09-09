/**
 * Loop-closure sweep scheduler (Deep Review v16 item 1.2).
 *
 * Periodically retries deferred fix-PR loop closures — merged PRs whose
 * automatic retest was deferred at webhook time by the concurrency cap,
 * worker unavailability or entitlement failure. Follows the same setInterval
 * pattern as startApprovalExpiryRunner / startBillingJobsScheduler.
 */

import { logger } from "@lyrashield/logger"
import { processLoopClosureSweep } from "./jobs/loop-closure-sweep.job"

const LOOP_CLOSURE_SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 min; backoff floor is 1 min

async function runLoopClosureSweep(): Promise<void> {
  const result = await processLoopClosureSweep()
  if (result.claimed > 0) {
    logger.info("Loop-closure sweep completed", { ...result })
  }
}

/** Start the loop-closure sweep. Returns the timer handle for shutdown cleanup. */
export function startLoopClosureSweepRunner(
  intervalMs = LOOP_CLOSURE_SWEEP_INTERVAL_MS
): NodeJS.Timeout {
  void runLoopClosureSweep().catch((error) => {
    logger.error("Loop-closure sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const timer = setInterval(() => {
    void runLoopClosureSweep().catch((error) => {
      logger.error("Loop-closure sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, intervalMs)

  logger.info("Loop-closure sweep runner started", { intervalMs })
  return timer
}
