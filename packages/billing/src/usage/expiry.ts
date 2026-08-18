/**
 * Pack expiry scheduled job.
 *
 * Runs periodically (e.g. hourly) to expire packs past their expiry date.
 * Expired packs have remainingMinutes set to 0 and are not counted in the
 * usage balance. The MinutePack row is NOT deleted — it remains for audit.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ExpirePacksResult {
  /** Number of packs expired in this run. */
  expired: number
}

/**
 * Expire all packs that have passed their expiry date and still have
 * remaining minutes. This is a scheduled job — call it from a BullMQ
 * repeatable job or a cron handler.
 */
export async function expirePacks(): Promise<ExpirePacksResult> {
  const now = new Date()

  const result = await prisma.minutePack.updateMany({
    where: {
      deletedAt: null,
      expiresAt: { lt: now },
      remainingMinutes: { gt: 0 },
    },
    data: {
      remainingMinutes: 0,
    },
  })

  if (result.count > 0) {
    logger.info("Expired minute packs", { count: result.count })
  }

  return { expired: result.count }
}
