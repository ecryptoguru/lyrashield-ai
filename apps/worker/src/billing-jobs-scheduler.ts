/**
 * Billing jobs scheduler.
 *
 * Starts periodic timers for billing-related maintenance jobs:
 * - billing-downgrade: hourly, downgrades expired canceled/past_due accounts to FREE
 * - billing-expire-packs: hourly, expires minute packs past their expiry date
 * - billing-allowance-replenishment: hourly, grants the current monthly
 *   allowance cycle (F1 — annual subscriptions get per-cycle pools)
 * - billing-reconciliation: daily, reports provider/webhook drift without
 *   changing billing, entitlements or provider state
 *
 * Follows the same setInterval pattern as startScheduleRunner.
 */

import { logger } from "@lyrashield/logger"
import { processBillingDowngradeJob } from "./jobs/billing-downgrade.job"
import { processBillingExpirePacksJob } from "./jobs/billing-expire-packs.job"
import { replenishAllowanceCycles } from "./jobs/billing-allowance-replenishment.job"
import { recoverDueWebhookTrackRetries } from "./jobs/webhook-track-retry.job"
import { runBillingReconciliation } from "./jobs/billing-reconciliation.job"

const BILLING_JOB_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const BILLING_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

function runBillingDowngrade(): void {
  void recoverDueWebhookTrackRetries().catch((error) => {
    logger.error("Webhook due retry recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
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

function runBillingReconciliationReport(): void {
  void runBillingReconciliation().catch((error) => {
    logger.error("Billing reconciliation job failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    logger.warn("operator_alert", {
      code: "reconciliation_drift",
      severity: "warning",
      alertCount: 1,
      alertSamples: [
        {
          provider: "internal",
          type: "job_failed",
          message: "Billing reconciliation did not complete; see worker error log",
        },
      ],
      truncatedAlertCount: 0,
    })
  })
}

/**
 * Start the billing jobs scheduler.
 * Runs maintenance jobs hourly and provider reconciliation once per day.
 * Returns an array of timer handles for cleanup on shutdown.
 */
export function startBillingJobsScheduler(intervalMs = BILLING_JOB_INTERVAL_MS): NodeJS.Timeout[] {
  // Run once on startup
  runBillingDowngrade()
  runBillingExpirePacks()
  runAllowanceReplenishment()
  runBillingReconciliationReport()

  const downgradeTimer = setInterval(runBillingDowngrade, intervalMs)
  const expirePacksTimer = setInterval(runBillingExpirePacks, intervalMs)
  const replenishmentTimer = setInterval(runAllowanceReplenishment, intervalMs)
  const reconciliationTimer = setInterval(
    runBillingReconciliationReport,
    BILLING_RECONCILIATION_INTERVAL_MS
  )

  logger.info("Billing jobs scheduler started", {
    intervalMs,
    reconciliationIntervalMs: BILLING_RECONCILIATION_INTERVAL_MS,
  })

  return [downgradeTimer, expirePacksTimer, replenishmentTimer, reconciliationTimer]
}
