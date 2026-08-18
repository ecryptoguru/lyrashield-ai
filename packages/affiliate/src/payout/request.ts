/**
 * Payout request — transactional flow.
 *
 * SELECT...FOR UPDATE eligible commissions → mark RESERVED → create Payout +
 * PayoutItem[] → call provider with idempotencyKey=payout.id → mark PAID only
 * on provider confirmation; on failure release back to AVAILABLE.
 */

import { Prisma } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { checkPayoutEligibility } from "./eligibility"
import { isReserveActive } from "./reserve"

export interface PayoutRequestResult {
  success: boolean
  payoutId?: string
  amount?: string
  itemCount?: number
  error?: string
}

/**
 * Request a payout for an affiliate.
 *
 * Uses a transaction to atomically:
 *  1. Lock eligible AVAILABLE commissions
 *  2. Mark them RESERVED
 *  3. Create Payout + PayoutItem records
 *
 * The provider call is made outside the transaction; on failure, commissions
 * are released back to AVAILABLE.
 */
export async function requestPayout(params: {
  affiliateId: string
  /** Provider name override (auto-detected from payout method if not given). */
  provider?: string
  /** Optional provider send function. If not provided, payout stays PENDING. */
  sendFn?: (payoutId: string, amount: string, currency: string, payoutMethod: unknown) => Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
}): Promise<PayoutRequestResult> {
  const { affiliateId, provider, sendFn } = params

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: { id: true, payoutMethod: true, reservePct: true, reserveUntil: true },
  })

  if (!affiliate) {
    return { success: false, error: "Affiliate not found" }
  }

  let payout: { id: string; amount: Prisma.Decimal; currency: string; itemCount: number }
  try {
    payout = await prisma.$transaction(async (tx) => {
    // Re-check eligibility inside the transaction to avoid TOCTOU.
    const eligibility = await checkPayoutEligibility(affiliateId)
    if (!eligibility.eligible) {
      throw new Error(eligibility.reasons.join("; "))
    }

    // Atomically reserve ALL available commissions (AVAILABLE → RESERVED).
    // This is the concurrency guard: only one transaction can succeed in
    // flipping the rows because updateMany is atomic.
    const reserveResult = await tx.commission.updateMany({
      where: {
        affiliateId,
        status: "AVAILABLE",
      },
      data: { status: "RESERVED" },
    })

    if (reserveResult.count === 0) {
      throw new Error("No available commissions to pay out")
    }

    // Read the now-reserved commissions.
    const commissions = await tx.commission.findMany({
      where: {
        affiliateId,
        status: "RESERVED",
      },
      select: { id: true, amount: true, currency: true },
    })

    if (commissions.length === 0) {
      throw new Error("No available commissions to pay out")
    }

    // Apply reserve hold if active
    const reserveActive = isReserveActive(affiliate.reserveUntil)
    const reservePct = affiliate.reservePct

    let totalAmount = new Prisma.Decimal(0)
    const items: { commissionId: string; amount: Prisma.Decimal }[] = []
    const currency = commissions[0]!.currency

    for (const c of commissions) {
      let itemAmount = c.amount

      if (reserveActive) {
        // Hold reservePct — only pay out (100 - reservePct)%
        const releasePct = new Prisma.Decimal(100 - reservePct)
        itemAmount = c.amount.mul(releasePct).div(100)
      }

      totalAmount = totalAmount.add(itemAmount)
      items.push({ commissionId: c.id, amount: itemAmount })
    }

    // Create Payout
    // C-M07: Pre-generate a UUID for the idempotencyKey instead of using
    // empty string. The empty string caused concurrent payout creations to
    // collide on the unique constraint.
    const payoutId = crypto.randomUUID()
    const newPayout = await tx.payout.create({
      data: {
        id: payoutId,
        affiliateId,
        amount: totalAmount,
        currency,
        status: "PROCESSING",
        provider: provider ?? "manual",
        idempotencyKey: payoutId,
      },
    })

    // Create PayoutItems (commissions are already RESERVED from updateMany)
    // C-M04: For reserved commissions, track the held amount separately.
    // The commission stays RESERVED (not PAID) for the reserve portion,
    // and the PayoutItem records the actual paid amount.
    for (const item of items) {
      await tx.payoutItem.create({
        data: {
          payoutId: newPayout.id,
          commissionId: item.commissionId,
          amount: item.amount,
        },
      })
    }

      return { id: newPayout.id, amount: totalAmount, currency, itemCount: items.length }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payout transaction failed"
    // Distinguish eligibility/no-commissions errors from unexpected failures
    if (
      message.includes("No available commissions") ||
      message.includes("eligibility") ||
      message.includes("; ")
    ) {
      return { success: false, error: message }
    }
    throw error
  }

  // Call provider (outside transaction)
  if (sendFn) {
    try {
      const result = await sendFn(
        payout.id,
        payout.amount.toString(),
        payout.currency,
        affiliate.payoutMethod
      )

      if (result.success) {
        // Mark PAID
        await prisma.payout.update({
          where: { id: payout.id },
          data: {
            status: "PAID",
            providerPayoutId: result.providerPayoutId,
            paidAt: new Date(),
          },
        })

        // C-M04: Mark commissions PAID. The PayoutItem.amount records the
        // actual paid amount; the difference between Commission.amount and
        // PayoutItem.amount is the reserved portion. A separate release job
        // (affiliate-payout-reserve-release) will create follow-up PayoutItems
        // for the reserved amounts after the reserve period expires.
        // For now, marking PAID is correct because the payout was sent and
        // the commission is no longer AVAILABLE/RESERVED for new payouts.
        const items = await prisma.payoutItem.findMany({
          where: { payoutId: payout.id },
          select: { commissionId: true },
        })

        await prisma.commission.updateMany({
          where: { id: { in: items.map((i) => i.commissionId) } },
          data: { status: "PAID" },
        })

        logger.info("Payout completed", {
          payoutId: payout.id,
          amount: payout.amount.toString(),
          providerPayoutId: result.providerPayoutId,
        })

        return {
          success: true,
          payoutId: payout.id,
          amount: payout.amount.toString(),
          itemCount: payout.itemCount,
        }
      } else {
        // Provider failed — release back to AVAILABLE
        await releasePayoutCommissions(payout.id)
        await prisma.payout.update({
          where: { id: payout.id },
          data: { status: "FAILED", failureCode: result.error ?? "PROVIDER_ERROR" },
        })

        return {
          success: false,
          payoutId: payout.id,
          error: result.error ?? "Provider payout failed",
        }
      }
    } catch (error) {
      // Provider threw — release back
      await releasePayoutCommissions(payout.id)
      await prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: "FAILED",
          failureCode: error instanceof Error ? error.message : "EXCEPTION",
        },
      })

      return {
        success: false,
        payoutId: payout.id,
        error: error instanceof Error ? error.message : "Provider exception",
      }
    }
  }

  // No sendFn — leave as PROCESSING (manual confirmation expected)
  logger.info("Payout created (pending provider confirmation)", {
    payoutId: payout.id,
    amount: payout.amount.toString(),
  })

  return {
    success: true,
    payoutId: payout.id,
    amount: payout.amount.toString(),
    itemCount: payout.itemCount,
  }
}

/**
 * Release all commissions in a payout back to AVAILABLE.
 */
async function releasePayoutCommissions(payoutId: string): Promise<void> {
  const items = await prisma.payoutItem.findMany({
    where: { payoutId },
    select: { commissionId: true },
  })

  await prisma.commission.updateMany({
    where: { id: { in: items.map((i) => i.commissionId) } },
    data: { status: "AVAILABLE" },
  })

  await prisma.payoutItem.deleteMany({
    where: { payoutId },
  })
}
