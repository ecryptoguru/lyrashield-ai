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
import { detectFraudSignals } from "../fraud/signals"
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
  /** Customer email — used for self-referral detection. */
  customerEmail?: string
  /** Gross amount in major currency units (e.g. 29.00). */
  grossAmount: string
  /** Discount amount in major currency units (e.g. 5.00). */
  discountAmount?: string
  /** Tax amount in major currency units. */
  taxAmount?: string
  /** Validated pre-tax, post-discount commission base in major units. */
  commissionableAmount: string
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
  /** Direct affiliate id (from checkout metadata — skips attribution resolution). */
  affiliateId?: string | null
  /** Click id (from checkout metadata — paired with affiliateId). */
  clickId?: string | null
  /** SubID for campaign tracking. */
  subid?: string | null
  /** Whether this is a first payment (vs renewal). */
  isFirstPayment?: boolean
  /** C-M09: IP hash for fraud signal detection. */
  ipHash?: string
  /** C-M09: Device fingerprint for fraud signal detection. */
  deviceFingerprint?: string
  /** C-M09: User agent hash for fraud signal detection. */
  userAgentHash?: string
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
export async function onOrderPaid(payload: OrderPaidPayload): Promise<OrderPaidResult> {
  const {
    provider,
    externalId,
    providerSubscriptionId,
    customerId,
    customerEmail,
    grossAmount,
    taxAmount = "0",
    commissionableAmount,
    currency,
    isAnnual = false,
    promoCode,
    cookieToken,
    affiliateId: directAffiliateId,
    subid,
    isFirstPayment = false,
  } = payload

  // Provider-scoped idempotency key prevents cross-provider collisions (C2)
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
      expired: commission?.status === "EXPIRED",
      duplicate: true,
    }
  }

  // Resolve attribution.
  // C1: If the payload carries a direct affiliateId (from checkout metadata),
  // skip attribution resolution and use it directly.
  let affiliateId: string
  let attributionMethod: string

  if (directAffiliateId) {
    // Verify the affiliate exists and is approved
    const directAffiliate = await prisma.affiliate.findUnique({
      where: { id: directAffiliateId },
      select: { id: true, status: true },
    })
    if (!directAffiliate || directAffiliate.status !== "APPROVED") {
      logger.info("Commission engine: direct affiliateId not approved", {
        externalId,
        directAffiliateId,
      })
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
    affiliateId = directAffiliateId
    attributionMethod = "direct_metadata"
  } else {
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
    affiliateId = attribution.affiliateId
    attributionMethod = attribution.method
  }

  // S2: Self-referral check — if the paying customer's email matches the
  // affiliate owner's email, reject the commission.
  const affiliateOwner = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: {
      userId: true,
      user: { select: { email: true } },
    },
  })

  if (
    affiliateOwner &&
    customerEmail &&
    affiliateOwner.user?.email &&
    affiliateOwner.user.email.toLowerCase() === customerEmail.toLowerCase()
  ) {
    logger.warn("Self-referral rejected", {
      externalId,
      affiliateId,
      customerEmail,
    })
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "SELF_REFERRAL_REJECTED",
      expired: false,
      duplicate: false,
    }
  }

  // S9: Fraud signal detection — block commission if high-severity signals found
  // C-M09: Pass IP hash, device fingerprint, and user agent hash to detectFraudSignals
  // for comprehensive fraud evaluation (not just email).
  // C-M10: Populate signupCountByIp / signupCountByDevice so the RATE_LIMIT_IP and
  // RATE_LIMIT_DEVICE signals actually evaluate. We count prior Clicks from the
  // same ipHash (IP proxy) and the same userAgent hash (device proxy) — a high
  // count signals abuse. deviceFingerprint is not persisted on Click, so the
  // userAgent hash is the available device-correlation key.
  let signupCountByIp: number | undefined
  let signupCountByDevice: number | undefined
  if (payload.ipHash || payload.userAgentHash) {
    const [byIp, byDevice] = await Promise.all([
      payload.ipHash
        ? prisma.click.count({ where: { ipHash: payload.ipHash } })
        : Promise.resolve(0),
      payload.userAgentHash
        ? prisma.click.count({ where: { userAgent: payload.userAgentHash } })
        : Promise.resolve(0),
    ])
    signupCountByIp = byIp
    signupCountByDevice = byDevice
  }
  const fraudResult = detectFraudSignals({
    email: customerEmail,
    ipHash: payload.ipHash,
    deviceFingerprint: payload.deviceFingerprint,
    userAgent: payload.userAgentHash,
    signupCountByIp,
    signupCountByDevice,
  })
  if (fraudResult.block) {
    logger.warn("Commission blocked by fraud signals", {
      externalId,
      affiliateId,
      signals: fraudResult.signals.map((s) => s.type),
    })
    return {
      conversionId: "",
      commissionId: "",
      amount: "0",
      rateBps: 0,
      status: "FRAUD_BLOCKED",
      expired: false,
      duplicate: false,
    }
  }

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
      // C5: Use calendar month arithmetic instead of 30-day months
      capEndsAt = new Date(now.getFullYear(), now.getMonth() + capMonths, now.getDate())
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
    const { conversion, commission } = await prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.create({
        data: {
          externalId,
          idempotencyKey,
          subscriptionId,
          affiliateId,
          grossAmount: new Prisma.Decimal(grossAmount),
          taxAmount: new Prisma.Decimal(taxAmount),
          commissionableAmount: new Prisma.Decimal(0),
          currency,
          method: attributionMethod,
          promoCode: promoCode ?? null,
          subid: subid ?? null,
          occurredAt: new Date(),
        },
      })
      const commission = await tx.commission.create({
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
      return { conversion, commission }
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
  const commissionableBase = new Prisma.Decimal(commissionableAmount)

  if (commissionableBase.lte(0)) {
    logger.warn("Commission: commissionable base <= 0, skipping", {
      externalId,
      grossAmount,
      commissionableAmount,
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
    // Annual Cloud plans: FLAT 25% of the annual amount as paid.
    // POLICY (founder-confirmed 2026-08-19): the 30% tier kicker
    // (TIER_RATE_BPS at >= TIER_THRESHOLD active referrals) applies to
    // MONTHLY Cloud plans only. Annual plans always pay the flat
    // ANNUAL_RATE_BPS regardless of the affiliate's tier — do not route
    // annual through the tier branch without an explicit founder decision.
    rateBps = ANNUAL_RATE_BPS
  } else if (
    affiliate &&
    affiliate.activeReferrals >= (affiliate.tierThreshold || TIER_THRESHOLD)
  ) {
    rateBps = affiliate.tierRateBps || TIER_RATE_BPS
  } else {
    rateBps = affiliate?.baseRateBps || BASE_RATE_BPS
  }

  // Compute commission amount
  // C-L07: Round to Decimal(19,4) before storage to prevent reconciliation drift
  // between stored values and in-memory/logged return values.
  const commissionAmount = commissionableBase
    .mul(rateBps)
    .div(10000)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)

  // Create Conversion + Commission
  const now = new Date()
  const availableAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000)

  const { conversion, commission } = await prisma.$transaction(async (tx) => {
    const conversion = await tx.conversion.create({
      data: {
        externalId,
        idempotencyKey,
        subscriptionId,
        affiliateId,
        grossAmount: gross,
        taxAmount: new Prisma.Decimal(taxAmount),
        commissionableAmount: commissionableBase,
        currency,
        method: attributionMethod,
        promoCode: promoCode ?? null,
        subid: subid ?? null,
        occurredAt: now,
      },
    })
    const commission = await tx.commission.create({
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
    return { conversion, commission }
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
