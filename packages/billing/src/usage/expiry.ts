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
 *
 * A-L03: Audit logs each expired pack for traceability.
 */
export async function expirePacks(): Promise<ExpirePacksResult> {
  const now = new Date()

  // Fetch the packs that will be expired so we can audit them
  const packsToExpire = await prisma.minutePack.findMany({
    where: {
      deletedAt: null,
      expiresAt: { lt: now },
      remainingMinutes: { gt: 0 },
    },
    select: { id: true, workspaceId: true, remainingMinutes: true },
  })

  if (packsToExpire.length === 0) {
    return { expired: 0 }
  }

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

  // A-L03: Create audit log entries for each expired pack
  for (const pack of packsToExpire) {
    await prisma.auditLog.create({
      data: {
        workspaceId: pack.workspaceId,
        action: "billing.pack_expired",
        resourceType: "minute_pack",
        resourceId: pack.id,
        metadata: { remainingMinutes: pack.remainingMinutes },
      },
    }).catch(() => {
      // Non-blocking — audit failure shouldn't break the expiry job
    })
  }

  if (result.count > 0) {
    logger.info("Expired minute packs", { count: result.count })
  }

  return { expired: result.count }
}
