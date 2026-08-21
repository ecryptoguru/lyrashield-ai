/**
 * Approval expiry scheduler.
 *
 * Periodically flips PENDING/APPROVED agent approvals whose TTL has passed to
 * EXPIRED. Mid-flight EXECUTING claims are never touched. Follows the same
 * setInterval pattern as startScheduleRunner / startBillingJobsScheduler.
 */

import { expireStaleApprovals } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

const APPROVAL_EXPIRY_INTERVAL_MS = 5 * 60 * 1000 // 5 min; approval TTL is 15 min

async function runApprovalExpiry(): Promise<void> {
  const expired = await expireStaleApprovals()
  if (expired > 0) {
    logger.info("Approval expiry sweep completed", { expired })
  }
}

/** Start the approval expiry sweep. Returns the timer handle for shutdown cleanup. */
export function startApprovalExpiryRunner(
  intervalMs = APPROVAL_EXPIRY_INTERVAL_MS
): NodeJS.Timeout {
  void runApprovalExpiry().catch((error) => {
    logger.error("Approval expiry sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const timer = setInterval(() => {
    void runApprovalExpiry().catch((error) => {
      logger.error("Approval expiry sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, intervalMs)

  logger.info("Approval expiry runner started", { intervalMs })
  return timer
}
