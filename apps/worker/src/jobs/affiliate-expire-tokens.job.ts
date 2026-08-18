import { expireAttributionTokens, type ExpireResult } from "@lyrashield/affiliate"
import { logger } from "@lyrashield/logger"

export const AFFILIATE_EXPIRE_TOKENS_QUEUE = "affiliate-expire-tokens"

export interface AffiliateExpireTokensJobData {
  scheduledAt: string
}

export interface AffiliateExpireTokensJobResult {
  deleted: number
}

/**
 * Daily job: cleanup expired AttributionToken rows.
 */
export async function processAffiliateExpireTokensJob(
  _data: AffiliateExpireTokensJobData
): Promise<AffiliateExpireTokensJobResult> {
  logger.info("Affiliate expire tokens job started")

  const result: ExpireResult = await expireAttributionTokens()

  logger.info("Affiliate expire tokens job complete", {
    deleted: result.deleted,
  })

  return { deleted: result.deleted }
}
