/**
 * Pack expiry scheduled job.
 *
 * Runs periodically (e.g. hourly) to expire packs past their expiry date.
 * Expired packs have remainingMinutes set to 0 and are not counted in the
 * usage balance. The MinutePack row is NOT deleted — it remains for audit.
 */

import { prisma, getSystemPrisma, withAccountRLS, withWorkspaceRLS } from "@lyrashield/db"
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
 * Packs are account-owned: the sweep iterates accounts (covering packs whose
 * attribution workspace was deleted) and workspaces (covering legacy rows
 * whose accountId is still NULL pending backfill).
 *
 * A-L03: Audit logs each expired pack for traceability.
 */
export async function expirePacks(): Promise<ExpirePacksResult> {
  const now = new Date()
  // Sweep the candidate packs once through the privileged system client, then
  // bind one tenant transaction per affected scope — never a transaction per
  // workspace/account that has nothing to expire.
  const candidates = await getSystemPrisma().minutePack.findMany({
    where: {
      deletedAt: null,
      expiresAt: { lt: now },
      remainingMinutes: { gt: 0 },
    },
    select: { accountId: true, workspaceId: true },
  })
  const accounts = [
    ...new Set(candidates.map((p) => p.accountId).filter((id): id is string => id !== null)),
  ]
  const workspaces = [
    ...new Set(
      candidates
        .filter((p) => p.accountId === null)
        .map((p) => p.workspaceId)
        .filter((id): id is string => id !== null)
    ),
  ]
  const packsToExpire: {
    id: string
    workspaceId: string | null
    accountId: string | null
    remainingMinutes: number
  }[] = []
  let expired = 0

  // Account-owned packs — including rows whose attribution workspace is NULL.
  for (const accountId of accounts) {
    const outcome = await withAccountRLS(accountId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${accountId}`}, 0))`
      const packs = await tx.minutePack.findMany({
        where: {
          accountId,
          deletedAt: null,
          expiresAt: { lt: now },
          remainingMinutes: { gt: 0 },
        },
        select: { id: true, workspaceId: true, accountId: true, remainingMinutes: true },
      })
      if (packs.length === 0) return { packs, count: 0 }
      const result = await tx.minutePack.updateMany({
        where: {
          accountId,
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

  // Legacy workspace-attributed packs whose accountId is still NULL.
  for (const workspaceId of workspaces) {
    const outcome = await withWorkspaceRLS(workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
      const packs = await tx.minutePack.findMany({
        where: {
          workspaceId,
          accountId: null,
          deletedAt: null,
          expiresAt: { lt: now },
          remainingMinutes: { gt: 0 },
        },
        select: { id: true, workspaceId: true, accountId: true, remainingMinutes: true },
      })
      if (packs.length === 0) return { packs, count: 0 }
      const result = await tx.minutePack.updateMany({
        where: {
          workspaceId,
          accountId: null,
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

  // A-L03: Create audit log entries for each expired pack. AuditLog needs a
  // workspace FK — skip packs whose attribution workspace is gone.
  for (const pack of packsToExpire) {
    if (!pack.workspaceId) continue
    await prisma.auditLog
      .create({
        data: {
          workspaceId: pack.workspaceId,
          action: "billing.pack_expired",
          resourceType: "minute_pack",
          resourceId: pack.id,
          metadata: { remainingMinutes: pack.remainingMinutes, accountId: pack.accountId },
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
