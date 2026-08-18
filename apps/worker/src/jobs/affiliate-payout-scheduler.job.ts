import { payoutScheduler, type PayoutBatch } from "@lyrashield/affiliate"
import { logger } from "@lyrashield/logger"

export const AFFILIATE_PAYOUT_SCHEDULER_QUEUE = "affiliate-payout-scheduler"

export interface AffiliatePayoutSchedulerJobData {
  scheduledAt: string
}

export interface AffiliatePayoutSchedulerJobResult {
  totalAffiliates: number
  successful: number
  failed: number
}

/**
 * Monthly job (15th): build eligible payout batches.
 */
export async function processAffiliatePayoutSchedulerJob(
  _data: AffiliatePayoutSchedulerJobData
): Promise<AffiliatePayoutSchedulerJobResult> {
  logger.info("Affiliate payout scheduler job started")

  const batches: PayoutBatch[] = await payoutScheduler()

  const successful = batches.filter((b) => b.success).length
  const failed = batches.filter((b) => !b.success).length

  logger.info("Affiliate payout scheduler job complete", {
    totalAffiliates: batches.length,
    successful,
    failed,
  })

  return {
    totalAffiliates: batches.length,
    successful,
    failed,
  }
}
