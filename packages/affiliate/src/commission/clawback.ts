/**
 * Commission clawback — on refund/chargeback.
 *
 * PENDING → REVERSED
 * AVAILABLE/PAID → update existing commission to REVERSED + amount 0
 *
 * S5: Instead of creating a NEW Commission row for the negative entry (which
 * violates the @@unique([conversionId, affiliateId]) constraint), we update the
 * EXISTING commission row in place. The original amount is logged for audit.
 *
 * C3: activeReferrals is decremented on first-payment subscription refunds.
 *
 * Reason codes: REFUND | CHARGEBACK | SELF_REFERRAL | FRAUD
 * > $200 manual review flag
 */

import { Prisma } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD } from "../index"

export type ClawbackReason = "REFUND" | "CHARGEBACK" | "SELF_REFERRAL" | "FRAUD"

export interface RefundPayload {
  workspaceId?: string | null
  /** Provider name. */
  provider: string
  /** External order/charge id. */
  externalId: string
  /** Provider refund row id (propagated from the normalized domain event). */
  refundId?: string | null
  /** Refund amount in major currency units. */
  refundAmount?: string
  /** Refund currency; must match the original conversion. */
  currency?: string
  /** Reason code. */
  reason: ClawbackReason
  /** Whether this is a chargeback (vs voluntary refund). */
  isChargeback?: boolean
}

export interface ClawbackResult {
  reversed: boolean
  commissionId?: string
  negativeEntryId?: string
  /** Whether this was flagged for manual review. */
  manualReview: boolean
  /** Whether the original commission was not found. */
  notFound: boolean
  /** Whether this was a no-op replay (commission already reversed). */
  replay?: boolean
}

/**
 * Process a refund or chargeback. Reverses the original commission.
 *
 * S5: For AVAILABLE/PAID commissions, the existing row is updated in place
 * (status → REVERSED, amount → 0) instead of creating a second Commission row
 * with the same (conversionId, affiliateId) which would violate the unique
 * constraint.
 */
export async function onRefund(payload: RefundPayload): Promise<ClawbackResult> {
  const { provider, externalId, reason } = payload

  // C-M01: Use provider-scoped idempotency key to match the key used when
  // the conversion was stored. The commission engine stores conversions with
  // idempotencyKey = `${provider}:${externalId}`, but the previous clawback
  // lookup used only `externalId`, causing every clawback to return notFound.
  const idempotencyKey = `${provider}:${externalId}`

  // Find the original conversion + commission
  const conversion = await prisma.conversion.findFirst({
    where: { idempotencyKey },
    include: { commissions: true, subscription: true },
  })

  if (!conversion || conversion.commissions.length === 0) {
    logger.warn("Clawback: no commission found for externalId", { externalId })
    return { reversed: false, manualReview: false, notFound: true }
  }

  const commission = conversion.commissions[0]!
  // A completed reversal has no remaining obligation, regardless of replayed
  // money facts or the historical amount. Do not audit/dead-letter it again.
  if (commission.status === "REVERSED") {
    return {
      reversed: true,
      commissionId: commission.id,
      manualReview: false,
      notFound: false,
      replay: true,
    }
  }
  const originalAmount = commission.amount
  const conversionAmount = conversion.grossAmount.toString()
  async function flagManualReview(reviewReason: string): Promise<ClawbackResult> {
    // Workspace binding comes from the normalized provider event, never a
    // guessed affiliate owner. Missing binding must dead-letter as well.
    if (!payload.workspaceId) throw new Error("affiliate_clawback_manual_review_missing_workspace")
    await prisma.auditLog.create({
      data: {
        workspaceId: payload.workspaceId,
        action: "affiliate.clawback.manual_review",
        resourceType: "commission",
        resourceId: commission.id,
        metadata: {
          commissionId: commission.id,
          originalAmount: originalAmount.toString(),
          conversionAmount,
          refundAmount: payload.refundAmount ?? null,
          currency: payload.currency ?? null,
          reason,
          reviewReason,
        },
      },
    })
    return { reversed: false, commissionId: commission.id, manualReview: true, notFound: false }
  }
  if (reason === "REFUND") {
    if (!payload.refundAmount || !payload.currency) {
      // Persist the review obligation; dispatch deliberately fails the required
      // track so it is retained for retry/dead-letter review, never succeeded.
      logger.error("Clawback: refund event missing amount or currency — manual review", {
        externalId,
      })
      return flagManualReview("missing_money_evidence")
    }
    const refundAmount = new Prisma.Decimal(payload.refundAmount)
    if (payload.currency !== conversion.currency || !refundAmount.equals(conversion.grossAmount)) {
      // Same principle: provider rounding drift or a partial/mismatched refund
      // is a reconciliation question for a human, not a silent pass and not a
      // dropped clawback. (Full-refund evidence is the billing layer's
      // precondition for emitting refund_completed, so a mismatch here means
      // the two systems disagree and must be reconciled by hand.)
      logger.error("Clawback: refund money mismatch with conversion — manual review", {
        externalId,
        refundCurrency: payload.currency,
        conversionCurrency: conversion.currency,
      })
      return flagManualReview("money_mismatch")
    }
  }
  const manualReview = originalAmount.gt(new Prisma.Decimal(CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD))
  if (manualReview) return flagManualReview("amount_above_threshold")

  // S5: Update the EXISTING commission in place — avoids the unique constraint
  // violation that would occur if we tried to create a new Commission row with
  // the same (conversionId, affiliateId).
  await prisma.commission.update({
    where: { id: commission.id },
    data: {
      status: "REVERSED",
      amount: new Prisma.Decimal(0),
    },
  })

  // Log the original amount for audit trail
  logger.info("Clawback: commission reversed", {
    commissionId: commission.id,
    externalId,
    reason,
    originalAmount: originalAmount.toString(),
    manualReview,
  })

  // C3: Decrement activeReferrals if this was a first-payment subscription.
  // Guard against going below 0.
  if (conversion.subscriptionId) {
    const affiliate = await prisma.affiliate.findUnique({
      where: { id: conversion.affiliateId },
      select: { activeReferrals: true },
    })

    if (affiliate && affiliate.activeReferrals > 0) {
      await prisma.affiliate.update({
        where: { id: conversion.affiliateId },
        data: { activeReferrals: { decrement: 1 } },
      })

      logger.info("Clawback: activeReferrals decremented", {
        affiliateId: conversion.affiliateId,
        previousCount: affiliate.activeReferrals,
      })
    }
  }

  return {
    reversed: true,
    commissionId: commission.id,
    manualReview,
    notFound: false,
  }
}
