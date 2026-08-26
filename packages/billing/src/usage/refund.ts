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

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
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
  resourceExternalId: string,
  refundExternalId = resourceExternalId
): Promise<ReverseRefundResult> {
  const idempotencyKey = `${workspaceId}:${refundExternalId}`
  let result: ReverseRefundResult
  try {
    result = await withWorkspaceRLS(workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${workspaceId}:${resourceExternalId}`}, 0))`
      const existing = await tx.usageRecord.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      })
      if (existing) return { created: false, reversed: "none" as const, minutesReversed: 0 }

      const pack = await tx.minutePack.findUnique({
        where: { workspaceId_externalId: { workspaceId, externalId: resourceExternalId } },
        select: { id: true, remainingMinutes: true },
      })
      if (!pack) throw new Error("refund_entitlement_not_resolved")

      const minutesReversed = pack.remainingMinutes
      const updated = await tx.minutePack.updateMany({
        where: { id: pack.id, workspaceId, remainingMinutes: pack.remainingMinutes },
        data: { remainingMinutes: 0 },
      })
      if (updated.count !== 1) throw new Error("refund_entitlement_balance_changed")
      await tx.usageRecord.create({
        data: {
          workspaceId,
          kind: "refund_reversal",
          quantity: minutesReversed,
          idempotencyKey,
          metadata: { refundExternalId, resourceExternalId, reversed: "pack", minutesReversed },
        },
      })
      return { created: true, reversed: "pack" as const, minutesReversed }
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
    reversed: result.reversed,
    minutesReversed: result.minutesReversed,
  })

  // A-L03: Audit log the refund reversal
  await prisma.auditLog
    .create({
      data: {
        workspaceId,
        action: "billing.refund_reversed",
        resourceType: "refund",
        resourceId: refundExternalId,
        metadata: { reversed: result.reversed, minutesReversed: result.minutesReversed },
      },
    })
    .catch(() => {
      // Non-blocking — audit failure shouldn't break the reversal
    })

  return result
}
