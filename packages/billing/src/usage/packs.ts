/**
 * Minute pack crediting.
 *
 * When a one-time pack purchase is confirmed (via Polar or Razorpay webhook),
 * the minutes are credited to the workspace as a MinutePack row.
 *
 * Idempotency: MinutePack has @@unique([workspaceId, externalId]), and the
 * UsageRecord for the grant uses idempotencyKey = `{workspaceId}:{packExternalId}`.
 */

import { withWorkspaceRLS } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { PACK_VALIDITY_DAYS } from "@lyrashield/pricing"

export type PackProvider = "polar" | "razorpay"

export interface CreditTopUpResult {
  created: boolean
  minutes: number
  packId: string | null
  expiresAt: Date | null
}

/**
 * Credit a minute pack top-up to a workspace.
 *
 * Creates a MinutePack row with the purchased minutes and a 6-month expiry.
 * Idempotent on (workspaceId, externalId) — replaying the same webhook
 * event will not create a duplicate pack.
 */
export async function creditTopUp(
  workspaceId: string,
  provider: PackProvider,
  minutes: number,
  expiresAt: Date | null,
  externalId: string
): Promise<CreditTopUpResult> {
  if (minutes <= 0) {
    return { created: false, minutes: 0, packId: null, expiresAt: null }
  }

  // Compute expiry if not provided (default 6 months from now)
  const expiry = expiresAt ?? new Date(Date.now() + PACK_VALIDITY_DAYS * 24 * 60 * 60 * 1000)

  return withWorkspaceRLS(workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`minute-pack:${workspaceId}:${provider}:${externalId}`}, 0))`
    // Idempotency: check existing pack by (workspaceId, externalId)
    const existing = await tx.minutePack.findUnique({
      where: {
        workspaceId_externalId: { workspaceId, externalId },
      },
      select: { id: true, minutes: true, deletedAt: true },
    })

    if (existing && !existing.deletedAt) {
      logger.debug("Idempotent replay of creditTopUp", { workspaceId, externalId })
      return {
        created: false,
        minutes: existing.minutes,
        packId: existing.id,
        expiresAt: expiry,
      }
    }

    if (existing?.deletedAt) {
      await tx.minutePack.update({
        where: { id: existing.id },
        data: {
          provider,
          deletedAt: null,
          minutes,
          remainingMinutes: minutes,
          expiresAt: expiry,
        },
      })
      logger.info("Restored soft-deleted minute pack", {
        workspaceId,
        externalId,
        packId: existing.id,
      })
      return { created: true, minutes, packId: existing.id, expiresAt: expiry }
    }

    const pack = await tx.minutePack.create({
      data: {
        workspaceId,
        provider,
        externalId,
        minutes,
        remainingMinutes: minutes,
        expiresAt: expiry,
      },
    })

    logger.info("Credited minute pack", {
      workspaceId,
      provider,
      externalId,
      minutes,
      packId: pack.id,
      expiresAt: expiry.toISOString(),
    })

    return { created: true, minutes, packId: pack.id, expiresAt: expiry }
  })
}
