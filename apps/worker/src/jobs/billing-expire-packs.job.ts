/**
 * Billing expire packs job.
 *
 * Hourly BullMQ repeatable job that calls expirePacks() to zero out
 * MinutePack rows that have passed their expiry date but still have
 * remaining minutes. The pack row is not deleted — it remains for audit.
 */

import { logger } from "@lyrashield/logger"
import { expirePacks, type ExpirePacksResult } from "@lyrashield/billing"

export const BILLING_EXPIRE_PACKS_QUEUE = "billing-expire-packs"

export interface BillingExpirePacksJobData {
  scheduledAt: string
}

export interface BillingExpirePacksJobResult {
  expired: number
}

/**
 * Process the billing expire packs job.
 * Expires all minute packs past their expiry date.
 */
export async function processBillingExpirePacksJob(
  _data: BillingExpirePacksJobData
): Promise<BillingExpirePacksJobResult> {
  logger.info("Billing expire packs job started")

  const result: ExpirePacksResult = await expirePacks()

  logger.info("Billing expire packs job complete", {
    expired: result.expired,
  })

  return { expired: result.expired }
}
