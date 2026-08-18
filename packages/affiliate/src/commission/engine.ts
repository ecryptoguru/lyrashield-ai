/**
 * Commission engine — `onOrderPaid(provider, externalId, payload)`.
 *
 * Idempotent via Conversion.idempotencyKey = externalId.
 *
 * Flow:
 *  1. Resolve AffiliateSubscription or pending attribution
 *  2. First payment → create AffiliateSubscription { firstPaidAt, capEndsAt: now+12mo }
 *  3. now > capEndsAt → EXPIRED amount=0
 *  4. rate = activeReferrals >= 10 ? 3000 : 2500
 *  5. base = net pre-tax after discounts
 *  6. Annual Cloud plans: commission at 25% of annual amount as paid
 *  7. Create Conversion + Commission { PENDING, availableAt: now+30d }
 */

import { Prisma } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { loadActiveProgram } from "../program"
import { resolveAttribution } from "../attribution/resolve"
import {
  BASE_RATE_BPS,
  TIER_RATE_BPS,
  TIER_THRESHOLD,
  ANNUAL_RATE_BPS,
  DEFAULT_HOLD_DAYS,
  DEFAULT_CAP_MONTHS,
  AFFILIATE_RULE_VERSION,
} from "../index"

export interface OrderPaidPayload {
  /** Provider name: "polar" | "razorpay" */
  provider: string
  /** External order/charge id (idempotency key). */
  externalId: string
  /** Provider subscription id (for recurring). */
  providerSubscriptionId?: string | null
  /** Provider customer id. */
  customerId: string
  /** Gross amount in major currency units (e.g. 29.00). */
  grossAmount: string
  /** Discount amount in major currency units (e.g. 5.00). */
  discountAmount?: string
  /** Tax amount in major currency units. */
  taxAmount?: string
  /** Currency code (USD, INR). */
  currency: string
  /** Whether this is an annual plan payment. */
  isAnnual?: boolean
  /** The plan/SKU id from @lyrashield/pricing. */
  planId?: string
  /** Promo code used at checkout (if any). */
  promoCode?: string | null
  /** Attribution cookie token (if available). */
  cookieToken?: string | null
  /** SubID for campaign tracking. */
  subid?: string | null
  /** Whether this is a first payment (vs renewal). */
  isFirstPayment?: boolean
}

export interface OrderPaidResult {
  conversionId: string
  commissionId: string
  amount: string
  rateBps: number
  status: string
  /** Whether the commission was expired (past cap). */
  expired: boolean
  /** Whether this was a duplicate (idempotent). */
  duplicate: boolean
}

/**
 * Process an order.paid webhook event for Cloud subscriptions.
 * Idempotent: if a Conversion with this externalId already exists, returns
 * the existing result without creating new records.
 */
export async function onOrderPaid(
  payload: OrderPaidPayload
): Promise<OrderPaidResult> {
  const {
    provider,
    externalId,
    providerSubscriptionId,
    customerId,
    grossAmount,
    discountAmount = "0",
    taxAmount = "0",
    currency,
    isAnnual = false,
    promoCode,
    cookieToken,
    subid,
    isFirstPayment = false,
  } = payload

  // Idempotency check
  const existing = await prisma.conversion.findFirst({
    where: { idempotencyKey: externalId },
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
      expired: commission?.status === "EXPIRED",
      duplicate: true,
    }
  }

  // Resolve attribution
  const attribution = await resolveAttribution({ promoCode, cookieToken })
  if (!attribution.affiliateId) {
    logger.info("Commission engine: no attribution for order", { externalId })
    // No attribution — skip commission creation (no unattributed conversion record
    // since the schema requires a valid affiliateId foreign key)
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "UNATTRIBUTED",
      expired: false,
      duplicate: false,
    }
  }

  const affiliateId = attribution.affiliateId

  // Load program terms
  let holdDays = DEFAULT_HOLD_DAYS
  let capMonths = DEFAULT_CAP_MONTHS
  try {
    const terms = await loadActiveProgram(env.AFFILIATE_DEFAULT_PROGRAM_SLUG)
    holdDays = terms.holdDays
    capMonths = terms.capMonths
  } catch {
    // Fall back to defaults
  }

  // Resolve or create AffiliateSubscription
  let subscriptionId: string | null = null
  let capEndsAt: Date | null = null
  let isExpired = false

  if (providerSubscriptionId) {
    const existingSub = await prisma.affiliateSubscription.findUnique({
      where: { providerSubscriptionId },
    })

    if (existingSub) {
      subscriptionId = existingSub.id
      capEndsAt = existingSub.capEndsAt
      isExpired = existingSub.capEndsAt < new Date()
    } else if (isFirstPayment) {
      // Create new subscription record
      const now = new Date()
      capEndsAt = new Date(
        now.getTime() + capMonths * 30 * 24 * 60 * 60 * 1000
      )
      const sub = await prisma.affiliateSubscription.create({
        data: {
          providerSubscriptionId,
          provider,
          customerId,
          affiliateId,
          firstPaidAt: now,
          capEndsAt,
          isActive: true,
        },
      })
      subscriptionId = sub.id

      // Update activeReferrals count
      await prisma.affiliate.update({
        where: { id: affiliateId },
        data: { activeReferrals: { increment: 1 } },
      })
    }
  }

  // If past cap → EXPIRED amount=0
  if (isExpired) {
    const conversion = await prisma.conversion.create({
      data: {
        externalId,
        idempotencyKey: externalId,
        subscriptionId,
        affiliateId,
        grossAmount: new Prisma.Decimal(grossAmount),
        commissionableAmount: new Prisma.Decimal(0),
        currency,
        method: attribution.method,
        promoCode: promoCode ?? null,
        subid: subid ?? null,
        occurredAt: new Date(),
      },
    })

    const commission = await prisma.commission.create({
      data: {
        conversionId: conversion.id,
        affiliateId,
        rateBps: 0,
        amount: new Prisma.Decimal(0),
        currency,
        status: "EXPIRED",
        earnedAt: new Date(),
        availableAt: null,
      },
    })

    logger.info("Commission: expired (past cap)", {
      externalId,
      affiliateId,
      capEndsAt,
    })

    return {
      conversionId: conversion.id,
      commissionId: commission.id,
      amount: "0",
      rateBps: 0,
      status: "EXPIRED",
      expired: true,
      duplicate: false,
    }
  }

  // Compute commissionable base: net pre-tax after discounts
  const gross = new Prisma.Decimal(grossAmount)
  const discount = new Prisma.Decimal(discountAmount)
  const tax = new Prisma.Decimal(taxAmount)
  const commissionableBase = gross.minus(discount).minus(tax)

  if (commissionableBase.lte(0)) {
    logger.warn("Commission: commissionable base <= 0, skipping", {
      externalId,
      grossAmount,
      discountAmount,
      taxAmount,
    })
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "SKIP",
      expired: false,
      duplicate: false,
    }
  }

  // Determine rate
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: { activeReferrals: true, baseRateBps: true, tierRateBps: true, tierThreshold: true },
  })

  let rateBps: number
  if (isAnnual) {
    // Annual Cloud plans: 25% of annual amount as paid
    rateBps = ANNUAL_RATE_BPS
  } else if (affiliate && affiliate.activeReferrals >= (affiliate.tierThreshold || TIER_THRESHOLD)) {
    rateBps = affiliate.tierRateBps || TIER_RATE_BPS
  } else {
    rateBps = affiliate?.baseRateBps || BASE_RATE_BPS
  }

  // Compute commission amount
  const commissionAmount = commissionableBase.mul(rateBps).div(10000)

  // Create Conversion + Commission
  const now = new Date()
  const availableAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000)

  const conversion = await prisma.conversion.create({
    data: {
      externalId,
      idempotencyKey: externalId,
      subscriptionId,
      affiliateId,
      grossAmount: gross,
      commissionableAmount: commissionableBase,
      currency,
      method: attribution.method,
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

  logger.info("Commission created", {
    externalId,
    affiliateId,
    rateBps,
    amount: commissionAmount.toString(),
    status: "PENDING",
    availableAt,
    ruleVersion: AFFILIATE_RULE_VERSION,
  })

  return {
    conversionId: conversion.id,
    commissionId: commission.id,
    amount: commissionAmount.toString(),
    rateBps,
    status: "PENDING",
    expired: false,
    duplicate: false,
  }
}
