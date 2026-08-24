/**
 * Local-license commission — 20% one-time commission on Local-license Polar
 * one-time order.paid for a Local SKU.
 *
 * Idempotent. No clawback except chargeback.
 */

import { Prisma } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { LOCAL_RATE_BPS, DEFAULT_HOLD_DAYS, AFFILIATE_RULE_VERSION } from "../index"
import { resolveAttribution } from "../attribution/resolve"
import { loadActiveProgram } from "../program"

export interface LocalOrderPaidPayload {
  /** Provider name (typically "polar"). */
  provider: string
  /** External order id (idempotency key). */
  externalId: string
  /** Provider customer id. */
  customerId: string
  /** Customer email — used for self-referral detection. */
  customerEmail?: string
  /** Gross amount in major currency units. */
  grossAmount: string
  /** Discount amount in major currency units. */
  discountAmount?: string
  /** Tax amount in major currency units. */
  taxAmount?: string
  /** Validated pre-tax, post-discount commission base in major units. */
  commissionableAmount: string
  /** Currency code. */
  currency: string
  /** The Local SKU id from @lyrashield/pricing. */
  skuId: string
  /** Promo code used at checkout (if any). */
  promoCode?: string | null
  /** Attribution cookie token (if available). */
  cookieToken?: string | null
  /** Internal affiliate identity resolved before provider redirect. */
  affiliateId?: string | null
  /** Internal click identity retained for reconciliation. */
  clickId?: string | null
  /** SubID for campaign tracking. */
  subid?: string | null
}

export interface LocalOrderPaidResult {
  conversionId: string
  commissionId: string
  amount: string
  rateBps: number
  status: string
  duplicate: boolean
}

/**
 * Process a Local-license one-time order.paid event.
 * 20% one-time commission, no clawback except chargeback.
 */
export async function onLocalOrderPaid(
  payload: LocalOrderPaidPayload
): Promise<LocalOrderPaidResult> {
  const {
    provider,
    externalId,
    customerEmail,
    grossAmount,
    commissionableAmount,
    currency,
    skuId,
    promoCode,
    cookieToken,
    affiliateId: directAffiliateId,
    subid,
  } = payload

  // C2: Provider-scoped idempotency key prevents cross-provider collisions
  const idempotencyKey = `${provider}:${externalId}`

  // Idempotency check
  const existing = await prisma.conversion.findFirst({
    where: { idempotencyKey },
    include: { commissions: true },
  })

  if (existing) {
    const commission = existing.commissions[0]
    return {
      conversionId: existing.id,
      commissionId: commission?.id ?? "",
      amount: commission?.amount.toString() ?? "0",
      rateBps: commission?.rateBps ?? 0,
      status: commission?.status ?? "PENDING",
      duplicate: true,
    }
  }

  let affiliateId: string | null = null
  let attributionMethod = "unattributed"
  if (directAffiliateId) {
    const direct = await prisma.affiliate.findUnique({
      where: { id: directAffiliateId },
      select: { id: true, status: true },
    })
    if (direct?.status === "APPROVED") {
      affiliateId = direct.id
      attributionMethod = "direct_metadata"
    }
  } else {
    const attribution = await resolveAttribution({ promoCode, cookieToken })
    affiliateId = attribution.affiliateId
    attributionMethod = attribution.method
  }
  if (!affiliateId) {
    logger.info("Local commission: no attribution for order", { externalId, skuId })
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "UNATTRIBUTED",
      duplicate: false,
    }
  }

  const affiliateOwner = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: { user: { select: { email: true } } },
  })
  if (
    customerEmail &&
    affiliateOwner?.user?.email &&
    customerEmail.toLowerCase() === affiliateOwner.user.email.toLowerCase()
  ) {
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "SELF_REFERRAL_REJECTED",
      duplicate: false,
    }
  }

  // Load program terms for hold days
  let holdDays = DEFAULT_HOLD_DAYS
  try {
    const terms = await loadActiveProgram(env.AFFILIATE_DEFAULT_PROGRAM_SLUG)
    holdDays = terms.holdDays
  } catch {
    // Fall back to defaults
  }

  // Compute commissionable base: net pre-tax after discounts
  const gross = new Prisma.Decimal(grossAmount)
  const commissionableBase = new Prisma.Decimal(commissionableAmount)

  if (commissionableBase.lte(0)) {
    logger.warn("Local commission: commissionable base <= 0, skipping", {
      externalId,
      grossAmount,
    })
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "SKIP",
      duplicate: false,
    }
  }

  // 20% one-time commission
  // C-L07: Round to Decimal(19,4) before storage to prevent reconciliation drift
  const rateBps = LOCAL_RATE_BPS
  const commissionAmount = commissionableBase
    .mul(rateBps)
    .div(10000)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)

  // Create Conversion + Commission
  const now = new Date()
  const availableAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000)

  const conversion = await prisma.conversion.create({
    data: {
      externalId,
      idempotencyKey,
      affiliateId,
      grossAmount: gross,
      commissionableAmount: commissionableBase,
      currency,
      method: attributionMethod,
      promoCode: promoCode ?? null,
      subid: subid ?? null,
      occurredAt: now,
    },
  })

  const commission = await prisma.commission.create({
    data: {
      conversionId: conversion.id,
      affiliateId,
      rateBps,
      amount: commissionAmount,
      currency,
      status: "PENDING",
      earnedAt: now,
      availableAt,
    },
  })

  logger.info("Local commission created", {
    externalId,
    affiliateId,
    skuId,
    rateBps,
    amount: commissionAmount.toString(),
    ruleVersion: AFFILIATE_RULE_VERSION,
  })

  return {
    conversionId: conversion.id,
    commissionId: commission.id,
    amount: commissionAmount.toString(),
    rateBps,
    status: "PENDING",
    duplicate: false,
  }
}
