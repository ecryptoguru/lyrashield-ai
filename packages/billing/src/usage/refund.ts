/**
 * Refund reversal.
 *
 * When a refund is processed (via Polar or Razorpay webhook), the
 * corresponding entitlement is reversed:
 * - For subscription refunds: the workspace is downgraded to FREE
 * - For pack refunds: the pack's remainingMinutes are zeroed out
 *
 * Idempotent on the refund external ID.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ReverseRefundResult {
  created: boolean
  /** What was reversed: "subscription" | "pack" | "none" */
  reversed: "subscription" | "pack" | "none"
  /** Minutes reversed (for pack refunds). */
  minutesReversed: number
}

/**
 * Reverse a refund by zeroing out the corresponding entitlement.
 *
 * For pack refunds: finds the MinutePack by externalId and zeros remainingMinutes.
 * For subscription refunds: the sync.ts layer handles plan downgrade; this
 * function records the reversal event for audit.
 *
 * Idempotent: the UsageRecord with kind="refund_reversal" uses
 * idempotencyKey = `{workspaceId}:{refundExternalId}`.
 */
export async function reverseRefund(
  workspaceId: string,
  refundExternalId: string
): Promise<ReverseRefundResult> {
  const idempotencyKey = `${workspaceId}:${refundExternalId}`

  // Check idempotency
  const existing = await prisma.usageRecord.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  })
  if (existing) {
    return { created: false, reversed: "none", minutesReversed: 0 }
  }

  // Try to find a pack with this externalId to reverse
  const pack = await prisma.minutePack.findUnique({
    where: {
      workspaceId_externalId: { workspaceId, externalId: refundExternalId },
    },
    select: { id: true, remainingMinutes: true },
  })

  let reversed: "subscription" | "pack" | "none" = "none"
  let minutesReversed = 0

  if (pack && pack.remainingMinutes > 0) {
    await prisma.minutePack.update({
      where: { id: pack.id },
      data: { remainingMinutes: 0 },
    })
    reversed = "pack"
    minutesReversed = pack.remainingMinutes
  }

  // Record the reversal event
  try {
    await prisma.usageRecord.create({
      data: {
        workspaceId,
        kind: "refund_reversal",
        quantity: minutesReversed,
        idempotencyKey,
        metadata: {
          refundExternalId,
          reversed,
          minutesReversed,
        },
      },
    })
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Idempotent replay of reverseRefund", { idempotencyKey })
      return { created: false, reversed: "none", minutesReversed: 0 }
    }
    throw error
  }

  logger.info("Reversed refund", {
    workspaceId,
    refundExternalId,
    reversed,
    minutesReversed,
  })

  // A-L03: Audit log the refund reversal
  await prisma.auditLog.create({
    data: {
      workspaceId,
      action: "billing.refund_reversed",
      resourceType: "refund",
      resourceId: refundExternalId,
      metadata: { reversed, minutesReversed },
    },
  }).catch(() => {
    // Non-blocking — audit failure shouldn't break the reversal
  })

  return { created: true, reversed, minutesReversed }
}
