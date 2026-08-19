/**
 * Expire attribution tokens — `expireAttributionTokens()`.
 *
 * Cleanup expired AttributionToken rows (past their expiresAt).
 * Called by the daily BullMQ job.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ExpireResult {
  deleted: number
}

/**
 * Delete expired attribution tokens.
 * Tokens that have been consumed are also cleaned up.
 */
export async function expireAttributionTokens(): Promise<ExpireResult> {
  const now = new Date()

  const result = await prisma.attributionToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lte: now } }, { consumed: true }],
    },
  })

  logger.info("Expired attribution tokens cleaned up", {
    deleted: result.count,
    cleanedAt: now,
  })

  return { deleted: result.count }
}
