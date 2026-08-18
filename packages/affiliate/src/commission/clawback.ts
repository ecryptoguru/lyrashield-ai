/**
 * Commission clawback — on refund/chargeback.
 *
 * PENDING → REVERSE
 * AVAILABLE/PAID → negative ledger entry
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
  /** Provider name. */
  provider: string
  /** External order/charge id. */
  externalId: string
  /** Refund amount in major currency units. */
  refundAmount?: string
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
}

/**
 * Process a refund or chargeback. Reverses the original commission.
 */
export async function onRefund(payload: RefundPayload): Promise<ClawbackResult> {
  const { externalId, reason } = payload

  // Find the original conversion + commission
  const conversion = await prisma.conversion.findFirst({
    where: { idempotencyKey: externalId },
    include: { commissions: true },
  })

  if (!conversion || conversion.commissions.length === 0) {
    logger.warn("Clawback: no commission found for externalId", { externalId })
    return { reversed: false, manualReview: false, notFound: true }
  }

  const commission = conversion.commissions[0]!
  const manualReview = commission.amount.gt(
    new Prisma.Decimal(CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD)
  )

  if (commission.status === "PENDING") {
    // PENDING → REVERSED
    await prisma.commission.update({
      where: { id: commission.id },
      data: { status: "REVERSED" },
    })

    logger.info("Clawback: PENDING commission reversed", {
      commissionId: commission.id,
      externalId,
      reason,
    })

    return {
      reversed: true,
      commissionId: commission.id,
      manualReview,
      notFound: false,
    }
  }

  // AVAILABLE or PAID → create negative ledger entry
  const negativeAmount = commission.amount.neg()

  const negativeEntry = await prisma.commission.create({
    data: {
      conversionId: conversion.id,
      affiliateId: conversion.affiliateId,
      rateBps: commission.rateBps,
      amount: negativeAmount,
      currency: commission.currency,
      status: "REVERSED",
      earnedAt: new Date(),
      availableAt: null,
      reversalOfId: commission.id,
    },
  })

  // Mark original as reversed
  await prisma.commission.update({
    where: { id: commission.id },
    data: { status: "REVERSED" },
  })

  logger.info("Clawback: negative ledger entry created", {
    originalCommissionId: commission.id,
    negativeEntryId: negativeEntry.id,
    externalId,
    reason,
    amount: negativeAmount.toString(),
    manualReview,
  })

  return {
    reversed: true,
    commissionId: commission.id,
    negativeEntryId: negativeEntry.id,
    manualReview,
    notFound: false,
  }
}
