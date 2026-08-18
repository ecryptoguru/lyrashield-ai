/**
 * Minute pack crediting.
 *
 * When a one-time pack purchase is confirmed (via Polar or Razorpay webhook),
 * the minutes are credited to the workspace as a MinutePack row.
 *
 * Idempotency: MinutePack has @@unique([workspaceId, externalId]), and the
 * UsageRecord for the grant uses idempotencyKey = `{workspaceId}:{packExternalId}`.
 */

import { prisma } from "@lyrashield/db"
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

  // Idempotency: check existing pack by (workspaceId, externalId)
  const existing = await prisma.minutePack.findUnique({
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

  // If soft-deleted, create a new one (the unique constraint allows it since
  // the old row has deletedAt set — but Prisma's unique constraint includes
  // soft-deleted rows, so we need to handle this differently)
  if (existing?.deletedAt) {
    // Restore the soft-deleted pack
    await prisma.minutePack.update({
      where: { id: existing.id },
      data: {
        deletedAt: null,
        minutes,
        remainingMinutes: minutes,
        expiresAt: expiry,
      },
    })
    logger.info("Restored soft-deleted minute pack", { workspaceId, externalId, packId: existing.id })
    return { created: true, minutes, packId: existing.id, expiresAt: expiry }
  }

  try {
    const pack = await prisma.minutePack.create({
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
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Concurrent idempotent replay of creditTopUp", { workspaceId, externalId })
      return { created: false, minutes, packId: null, expiresAt: expiry }
    }
    throw error
  }
}
