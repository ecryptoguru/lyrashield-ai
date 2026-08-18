import { reconciliationJob, type ReconciliationResult } from "@lyrashield/affiliate"
import { logger } from "@lyrashield/logger"

export const AFFILIATE_RECONCILIATION_QUEUE = "affiliate-reconciliation"

export interface AffiliateReconciliationJobData {
  scheduledAt: string
}

export interface AffiliateReconciliationJobResult {
  conversionsChecked: number
  payoutsChecked: number
  driftCount: number
}

/**
 * Daily job: compare internal commissions/payouts vs Polar/Razorpay exports.
 * Flag drift for manual review.
 */
export async function processAffiliateReconciliationJob(
  data: AffiliateReconciliationJobData
): Promise<AffiliateReconciliationJobResult> {
  logger.info("Affiliate reconciliation job started", { scheduledAt: data.scheduledAt })

  const result: ReconciliationResult = await reconciliationJob()

  logger.info("Affiliate reconciliation job complete", {
    conversionsChecked: result.conversionsChecked,
    payoutsChecked: result.payoutsChecked,
    driftCount: result.driftItems.length,
  })

  if (result.driftItems.length > 0) {
    logger.warn("Affiliate reconciliation drift detected", {
      driftItems: result.driftItems,
    })
  }

  return {
    conversionsChecked: result.conversionsChecked,
    payoutsChecked: result.payoutsChecked,
    driftCount: result.driftItems.length,
  }
}
