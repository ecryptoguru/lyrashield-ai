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
  /** Number of affiliates whose reserve was released this run. */
  affiliatesReleased: number
  /** Number of commissions whose reserved portion was released. */
  commissionsReleased: number
  /** Total reserved amount released this run, per currency. */
  totals: Record<string, string>
}

/**
 * Release the reserved portion for a single affiliate whose reserve period
 * has expired. Idempotent: commissions with reserveReleasedAt set are
 * skipped, so a replay or a re-run of the scheduler is a no-op.
 *
 * Creates a single reserve-release Payout (isReserveRelease = true) with one
 * PayoutItem per released commission, marks each commission
 * reserveReleasedAt + reserveReleasedAmount, and writes an audit log.
 *
 * The payout is created in PENDING status — it still goes through the normal
 * admin approval / provider send flow. This function does NOT move money; it
 * only creates the payable record for the reserved amounts.
 */
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

  // Only release once the reserve window has actually expired.
  if (isReserveActive(affiliate.reserveUntil, now)) {
    return { released: 0, totalAmount: new Prisma.Decimal(0), currency: null }
  }

  // Find PAID commissions for this affiliate that were paid with a reserve
  // held back (Commission.amount > PayoutItem.amount) and have not yet had
  // their reserve released.
  const paidCommissions = await prisma.commission.findMany({
    where: {
      affiliateId,
      status: "PAID",
      reserveReleasedAt: null,
      // The commission must have at least one payout item (the main payout).
      payoutItems: { some: {} },
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      // The first NON-reserve-release payout item is the main payout; its amount
      // is what was already paid. The reserved delta is Commission.amount - this.
      payoutItems: {
        where: { payout: { isReserveRelease: false } },
        take: 1,
        select: { amount: true },
      },
    },
  })

  // Compute the reserved delta per commission (full amount - already-paid amount).
  const releaseItems: { commissionId: string; amount: Prisma.Decimal }[] = []
  let totalAmount = new Prisma.Decimal(0)
  let currency: string | null = null

  for (const c of paidCommissions) {
    const alreadyPaid = c.payoutItems[0]?.amount ?? new Prisma.Decimal(0)
    const reservedDelta = c.amount.minus(alreadyPaid)
    if (reservedDelta.lte(0)) {
      // No reserve was held for this commission (e.g. reserve was not active
      // when it was paid). Mark it released with a zero amount so it is not
      // reconsidered on every run.
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

  // Create the reserve-release payout + items + mark commissions, in one
  // transaction. Idempotency: the commission.reserveReleasedAt filter above
  // guarantees we only ever pick up unreleased commissions, and we set
  // reserveReleasedAt inside the same tx so a concurrent run cannot double-
  // release.
  const payoutId = `${affiliateId}:reserve-release:${now.toISOString()}`
  const finalCurrency = currency ?? "USD"

  await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.create({
      data: {
        id: payoutId,
        affiliateId,
        amount: totalAmount,
        currency: finalCurrency,
        status: "PENDING",
        isReserveRelease: true,
        idempotencyKey: `reserve-release:${affiliateId}`,
        provider: null,
      },
    })

    for (const item of releaseItems) {
      await tx.payoutItem.create({
        data: {
          payoutId: payout.id,
          commissionId: item.commissionId,
          amount: item.amount,
        },
      })
      await tx.commission.update({
        where: { id: item.commissionId },
        data: {
          reserveReleasedAt: now,
          reserveReleasedAmount: item.amount,
        },
      })
    }

    // AuditLog.workspaceId is a hard FK to Workspace. An affiliate has no
    // natural workspace, so resolve the owning workspace via the affiliate's
    // user → workspace membership. If the affiliate has no workspace (e.g. an
    // individual account not yet in a workspace), skip the audit write rather
    // than violating the FK (previously this wrote affiliateId into the
    // Workspace FK column and was silently swallowed by the catch).
    const affiliateRow = await tx.affiliate.findUnique({
      where: { id: affiliateId },
      select: { userId: true },
    })
    const membership = affiliateRow
      ? await tx.workspaceMember.findFirst({
          where: { userId: affiliateRow.userId },
          select: { workspaceId: true },
        })
      : null

    if (membership) {
      await tx.auditLog
        .create({
          data: {
            workspaceId: membership.workspaceId,
            action: "affiliate.reserve_released",
            resourceType: "payout",
            resourceId: payout.id,
            metadata: {
              affiliateId,
              commissionsReleased: releaseItems.length,
              totalAmount: totalAmount.toString(),
              currency: finalCurrency,
            },
          },
        })
        .catch(() => {})
    } else {
      logger.warn("Reserve released but no owning workspace found — audit log skipped", {
        affiliateId,
        payoutId: payout.id,
      })
    }
  })

  logger.info("Reserve released for affiliate", {
    affiliateId,
    commissionsReleased: releaseItems.length,
    totalAmount: totalAmount.toString(),
    currency: finalCurrency,
  })

  return { released: releaseItems.length, totalAmount, currency: finalCurrency }
}

/**
 * Scheduled reserve-release pass: find every affiliate whose reserve period
 * has expired and release their held reserve. Called by the BullMQ
 * affiliate-reserve-release job.
 */
export async function releaseReserve(now: Date = new Date()): Promise<ReserveReleaseResult> {
  const expiredAffiliates = await prisma.affiliate.findMany({
    where: {
      reserveUntil: { lt: now },
    },
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

  logger.info("Reserve release pass complete", {
    affiliatesReleased,
    commissionsReleased,
    totals,
  })

  return { affiliatesReleased, commissionsReleased, totals }
}
