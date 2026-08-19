/**
 * C-L05: Stuck PROCESSING payouts release job.
 *
 * Payouts stuck in PROCESSING status for more than 30 days are likely
 * abandoned (provider never confirmed, manual approval forgotten). This
 * job releases the reserved commissions back to AVAILABLE so the affiliate
 * can request a new payout.
 *
 * Runs daily as a BullMQ repeatable job.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface StuckPayoutReleaseResult {
  /** Number of stuck payouts found. */
  found: number
  /** Number of payouts released back to AVAILABLE. */
  released: number
}

/** Payouts older than this (in days) in PROCESSING status are considered stuck. */
const STUCK_THRESHOLD_DAYS = 30

export async function releaseStuckProcessingPayouts(): Promise<StuckPayoutReleaseResult> {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_DAYS * 24 * 60 * 60 * 1000)

  const stuckPayouts = await prisma.payout.findMany({
    where: {
      status: "PROCESSING",
      requestedAt: { lt: threshold },
    },
    select: { id: true, affiliateId: true, requestedAt: true },
  })

  const result: StuckPayoutReleaseResult = {
    found: stuckPayouts.length,
    released: 0,
  }

  for (const payout of stuckPayouts) {
    try {
      // Release commissions back to AVAILABLE
      const items = await prisma.payoutItem.findMany({
        where: { payoutId: payout.id },
        select: { commissionId: true },
      })

      await prisma.commission.updateMany({
        where: { id: { in: items.map((i) => i.commissionId) }, status: "RESERVED" },
        data: { status: "AVAILABLE" },
      })

      // Mark payout as FAILED with a descriptive code
      await prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: "FAILED",
          failureCode: "STUCK_PROCESSING_TIMEOUT",
        },
      })

      // Delete payout items
      await prisma.payoutItem.deleteMany({
        where: { payoutId: payout.id },
      })

      result.released++
      logger.warn("Stuck PROCESSING payout released", {
        payoutId: payout.id,
        affiliateId: payout.affiliateId,
        requestedAt: payout.requestedAt,
      })
    } catch (error) {
      logger.error("Failed to release stuck payout", {
        payoutId: payout.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (result.found > 0) {
    logger.info("Stuck payout release complete", {
      found: result.found,
      released: result.released,
    })
  }

  return result
}
