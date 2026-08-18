import { releaseReserve, type ReserveReleaseResult } from "@lyrashield/affiliate"
import { logger } from "@lyrashield/logger"

export const AFFILIATE_RESERVE_RELEASE_QUEUE = "affiliate-reserve-release"

export interface AffiliateReserveReleaseJobData {
  /** ISO timestamp for the scheduled run. */
  scheduledAt: string
}

export interface AffiliateReserveReleaseJobResult {
  affiliatesReleased: number
  commissionsReleased: number
}

/**
 * Daily job: release the reserved portion of commissions for affiliates
 * whose new-affiliate reserve period (90 days) has expired.
 *
 * For each affiliate past reserveUntil, the reserved delta per PAID
 * commission (Commission.amount - PayoutItem.amount) is collected into a
 * reserve-release Payout (isReserveRelease = true, PENDING status for
 * admin approval) and each commission is marked reserveReleasedAt so the
 * job is idempotent across replays.
 */
export async function processAffiliateReserveReleaseJob(
  _data: AffiliateReserveReleaseJobData
): Promise<AffiliateReserveReleaseJobResult> {
  logger.info("Affiliate reserve-release job started")

  const result: ReserveReleaseResult = await releaseReserve()

  logger.info("Affiliate reserve-release job complete", {
    affiliatesReleased: result.affiliatesReleased,
    commissionsReleased: result.commissionsReleased,
  })

  return {
    affiliatesReleased: result.affiliatesReleased,
    commissionsReleased: result.commissionsReleased,
  }
}
