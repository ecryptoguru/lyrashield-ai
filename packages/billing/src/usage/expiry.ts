/**
 * Pack expiry scheduled job.
 *
 * Runs periodically (e.g. hourly) to expire packs past their expiry date.
 * Expired packs have remainingMinutes set to 0 and are not counted in the
 * usage balance. The MinutePack row is NOT deleted — it remains for audit.
 */

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
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
  // Workspace itself is deliberately unscoped. Sweep its IDs, then bind each
  // tenant transaction through FORCE RLS instead of broadening the privileged
  // system client's license-only trust boundary.
  const workspaces = await prisma.workspace.findMany({ select: { id: true } })
  const packsToExpire: { id: string; workspaceId: string; remainingMinutes: number }[] = []
  let expired = 0
  for (const workspace of workspaces) {
    const outcome = await withWorkspaceRLS(workspace.id, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspace.id}, 0))`
      const packs = await tx.minutePack.findMany({
        where: {
          workspaceId: workspace.id,
          deletedAt: null,
          expiresAt: { lt: now },
          remainingMinutes: { gt: 0 },
        },
        select: { id: true, workspaceId: true, remainingMinutes: true },
      })
      if (packs.length === 0) return { packs, count: 0 }
      const result = await tx.minutePack.updateMany({
        where: {
          workspaceId: workspace.id,
          deletedAt: null,
          expiresAt: { lt: now },
          remainingMinutes: { gt: 0 },
        },
        data: { remainingMinutes: 0 },
      })
      return { packs, count: result.count }
    })
    packsToExpire.push(...outcome.packs)
    expired += outcome.count
  }

  if (packsToExpire.length === 0) {
    return { expired: 0 }
  }

  // A-L03: Create audit log entries for each expired pack
  for (const pack of packsToExpire) {
    await prisma.auditLog
      .create({
        data: {
          workspaceId: pack.workspaceId,
          action: "billing.pack_expired",
          resourceType: "minute_pack",
          resourceId: pack.id,
          metadata: { remainingMinutes: pack.remainingMinutes },
        },
      })
      .catch(() => {
        // Non-blocking — audit failure shouldn't break the expiry job
      })
  }

  if (expired > 0) {
    logger.info("Expired minute packs", { count: expired })
  }

  return { expired }
}
