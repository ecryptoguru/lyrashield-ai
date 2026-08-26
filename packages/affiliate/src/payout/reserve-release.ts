/**
 * Reserve release — releases the reserved portion of commissions once an
 * affiliate's new-affiliate reserve period (reserveUntil, 90 days) expires.
 *
 * At payout time the reserve holds back reservePct of each commission; only
 * (100 - reservePct)% is paid. The remaining reserved portion is recorded
 * implicitly as Commission.amount - PayoutItem.amount. This module finds
 * affiliates past their reserve window, computes the reserved delta per
 * commission, creates a reserve-release Payout + PayoutItems, and marks each
 * commission reserveReleasedAt so the job is idempotent.
 */

import { prisma, Prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { isReserveActive } from "./reserve"

export interface ReserveReleaseResult {
  affiliatesReleased: number
  commissionsReleased: number
  totals: Record<string, string>
}

export async function releaseReserveForAffiliate(
  affiliateId: string,
  now: Date = new Date()
): Promise<{ released: number; totalAmount: Prisma.Decimal; currency: string | null }> {
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: { id: true, reserveUntil: true, reservePct: true },
  })
  if (!affiliate) {
    logger.warn("releaseReserveForAffiliate: affiliate not found", { affiliateId })
    return { released: 0, totalAmount: new Prisma.Decimal(0), currency: null }
  }

  if (isReserveActive(affiliate.reserveUntil, now)) {
    return { released: 0, totalAmount: new Prisma.Decimal(0), currency: null }
  }

  // Capture-only: eligible IDs captured once, filtered PAID + reserveReleasedAt=null
  const paidCommissions = await prisma.commission.findMany({
    where: {
      affiliateId,
      status: "PAID",
      reserveReleasedAt: null,
      payoutItems: { some: {} },
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      payoutItems: {
        where: { payout: { isReserveRelease: false } },
        take: 1,
        select: { amount: true },
      },
    },
  })

  const releaseItems: { commissionId: string; amount: Prisma.Decimal }[] = []
  let totalAmount = new Prisma.Decimal(0)
  let currency: string | null = null

  for (const c of paidCommissions) {
    const alreadyPaid = c.payoutItems[0]?.amount ?? new Prisma.Decimal(0)
    const reservedDelta = c.amount
      .minus(alreadyPaid)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    if (reservedDelta.lte(0)) {
      releaseItems.push({ commissionId: c.id, amount: new Prisma.Decimal(0) })
      continue
    }
    if (currency === null) currency = c.currency
    totalAmount = totalAmount.plus(reservedDelta)
    releaseItems.push({ commissionId: c.id, amount: reservedDelta })
  }

  if (releaseItems.length === 0) {
    return { released: 0, totalAmount: new Prisma.Decimal(0), currency: null }
  }

  const finalCurrency = currency ?? "USD"

  const outcome = await prisma.$transaction(async (tx) => {
    const claimed: { commissionId: string; amount: Prisma.Decimal }[] = []
    for (const item of releaseItems) {
      const result = await tx.commission.updateMany({
        where: { id: item.commissionId, reserveReleasedAt: null },
        data: { reserveReleasedAt: now, reserveReleasedAmount: item.amount },
      })
      if (result.count === 1) claimed.push(item)
    }

    if (claimed.length === 0) return null

    const payable = claimed.filter((item) => item.amount.gt(0))
    const claimedTotal = payable.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0))
    if (payable.length === 0) {
      return { released: claimed.length, totalAmount: claimedTotal, payoutId: null }
    }

    const payoutId = `${affiliateId}:reserve-release:${now.toISOString()}`
    const payout = await tx.payout.create({
      data: {
        id: payoutId,
        affiliateId,
        amount: claimedTotal,
        currency: finalCurrency,
        status: "PENDING",
        isReserveRelease: true,
        idempotencyKey: `reserve-release:${affiliateId}`,
        provider: null,
      },
    })
    for (const item of payable) {
      await tx.payoutItem.create({
        data: {
          payoutId: payout.id,
          commissionId: item.commissionId,
          amount: item.amount,
          isReserveRelease: true,
        },
      })
    }
    return { released: claimed.length, totalAmount: claimedTotal, payoutId: payout.id }
  })

  if (!outcome) return { released: 0, totalAmount: new Prisma.Decimal(0), currency: null }

  if (outcome.payoutId) {
    const affiliateRow = await prisma.affiliate.findUnique({
      where: { id: affiliateId },
      select: { userId: true },
    })
    const membership = affiliateRow
      ? await prisma.workspaceMember.findFirst({
          where: { userId: affiliateRow.userId },
          select: { workspaceId: true },
        })
      : null
    if (membership) {
      await prisma.auditLog
        .create({
          data: {
            workspaceId: membership.workspaceId,
            action: "affiliate.reserve_released",
            resourceType: "payout",
            resourceId: outcome.payoutId,
            metadata: {
              affiliateId,
              commissionsReleased: outcome.released,
              totalAmount: outcome.totalAmount.toString(),
              currency: finalCurrency,
            },
          },
        })
        .catch(() => {})
    } else {
      logger.warn("Reserve released but no owning workspace found — audit log skipped", {
        affiliateId,
        payoutId: outcome.payoutId,
      })
    }
  }

  logger.info("Reserve released for affiliate", {
    affiliateId,
    commissionsReleased: outcome.released,
    totalAmount: outcome.totalAmount.toString(),
    currency: finalCurrency,
  })

  return { released: outcome.released, totalAmount: outcome.totalAmount, currency: finalCurrency }
}

export async function releaseReserve(now: Date = new Date()): Promise<ReserveReleaseResult> {
  const expiredAffiliates = await prisma.affiliate.findMany({
    where: { reserveUntil: { lt: now } },
    select: { id: true },
  })

  const totals: Record<string, string> = {}
  let commissionsReleased = 0
  let affiliatesReleased = 0

  for (const a of expiredAffiliates) {
    try {
      const result = await releaseReserveForAffiliate(a.id, now)
      if (result.released > 0) {
        affiliatesReleased += 1
        commissionsReleased += result.released
        if (result.currency) {
          const prev = new Prisma.Decimal(totals[result.currency] ?? 0)
          totals[result.currency] = prev.plus(result.totalAmount).toString()
        }
      }
    } catch (err) {
      logger.error("Reserve release failed for affiliate", {
        affiliateId: a.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info("Reserve release pass complete", { affiliatesReleased, commissionsReleased, totals })

  return { affiliatesReleased, commissionsReleased, totals }
}
