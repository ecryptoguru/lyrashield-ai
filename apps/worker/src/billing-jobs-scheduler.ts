/**
 * Billing jobs scheduler.
 *
 * Starts periodic timers for billing-related maintenance jobs:
 * - billing-downgrade: hourly, downgrades expired canceled/past_due accounts to FREE
 * - billing-expire-packs: hourly, expires minute packs past their expiry date
 * - billing-allowance-replenishment: hourly, grants the current monthly
 *   allowance cycle (F1 — annual subscriptions get per-cycle pools)
 *
 * Follows the same setInterval pattern as startScheduleRunner.
 */

import { logger } from "@lyrashield/logger"
import { processBillingDowngradeJob } from "./jobs/billing-downgrade.job"
import { processBillingExpirePacksJob } from "./jobs/billing-expire-packs.job"
import { replenishAllowanceCycles } from "./jobs/billing-allowance-replenishment.job"

const BILLING_JOB_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

function runBillingDowngrade(): void {
  void processBillingDowngradeJob({ scheduledAt: new Date().toISOString() }).catch((error) => {
    logger.error("Billing downgrade job failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

function runBillingExpirePacks(): void {
  void processBillingExpirePacksJob({ scheduledAt: new Date().toISOString() }).catch((error) => {
    logger.error("Billing expire packs job failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

function runAllowanceReplenishment(): void {
  void replenishAllowanceCycles().catch((error) => {
    logger.error("Allowance replenishment job failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/**
 * Start the billing jobs scheduler.
 * Runs the downgrade, expire-packs, and allowance-replenishment jobs hourly.
 * Returns an array of timer handles for cleanup on shutdown.
 */
export function startBillingJobsScheduler(intervalMs = BILLING_JOB_INTERVAL_MS): NodeJS.Timeout[] {
  // Run once on startup
  runBillingDowngrade()
  runBillingExpirePacks()
  runAllowanceReplenishment()

  const downgradeTimer = setInterval(runBillingDowngrade, intervalMs)
  const expirePacksTimer = setInterval(runBillingExpirePacks, intervalMs)
  const replenishmentTimer = setInterval(runAllowanceReplenishment, intervalMs)

  logger.info("Billing jobs scheduler started", { intervalMs })

  return [downgradeTimer, expirePacksTimer, replenishmentTimer]
}
