import { releaseCommissions, type ReleaseResult } from "@lyrashield/affiliate"
import { logger } from "@lyrashield/logger"

export const AFFILIATE_RELEASE_QUEUE = "affiliate-release-commissions"

export interface AffiliateReleaseJobData {
  /** ISO timestamp for the scheduled run. */
  scheduledAt: string
}

export interface AffiliateReleaseJobResult {
  released: number
}

/**
 * Hourly job: release PENDING commissions whose availableAt has passed.
 * PENDING → AVAILABLE where availableAt <= now.
 */
export async function processAffiliateReleaseJob(
  _data: AffiliateReleaseJobData
): Promise<AffiliateReleaseJobResult> {
  logger.info("Affiliate release commissions job started")

  const result: ReleaseResult = await releaseCommissions()

  logger.info("Affiliate release commissions job complete", {
    released: result.released,
  })

  return { released: result.released }
}
