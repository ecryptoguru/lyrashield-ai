/**
 * Payout request — transactional flow.
 *
 * Capture-only discipline: eligible commission IDs are captured once atomically
 * and every later step references ONLY that captured set (no re-query by
 * status). Provider call is outside the tx; finalize/release is a single
 * internal tx with CAS predicates and provider identity persisted for
 * convergent retry.
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

export async function requestPayout(params: {
  affiliateId: string
  provider?: string
  sendFn?: (
    payoutId: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ) => Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
}): Promise<PayoutRequestResult> {
  const { affiliateId, provider, sendFn } = params

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: { id: true, payoutMethod: true, reservePct: true, reserveUntil: true },
  })

  if (!affiliate) {
    return { success: false, error: "Affiliate not found" }
  }

  let payout: {
    id: string
    amount: Prisma.Decimal
    currency: string
    itemCount: number
    capturedIds: string[]
  }
  try {
    payout = await prisma.$transaction(async (tx) => {
      const eligibility = await checkPayoutEligibility(affiliateId)
      if (!eligibility.eligible) {
        throw new Error(eligibility.reasons.join("; "))
      }

      // Capture-only: read AVAILABLE commissions once
      const available = await tx.commission.findMany({
        where: { affiliateId, status: "AVAILABLE" },
        select: { id: true, amount: true, currency: true },
      })

      if (available.length === 0) {
        throw new Error("No available commissions to pay out")
      }

      const capturedIds = available.map((c) => c.id)

      // CAS reserve: only AVAILABLE rows in captured set can become RESERVED
      const reserveResult = await tx.commission.updateMany({
        where: { id: { in: capturedIds }, status: "AVAILABLE" },
        data: { status: "RESERVED" },
      })

      if (reserveResult.count === 0) {
        throw new Error("No available commissions to pay out")
      }
      if (reserveResult.count !== capturedIds.length) {
        // Partial capture = concurrent winner took some; abort to avoid mixing stale set
        throw new Error("Concurrent payout conflict — retry")
      }

      const reserveActive = isReserveActive(affiliate.reserveUntil)
      const reservePct = affiliate.reservePct

      let totalAmount = new Prisma.Decimal(0)
      const items: { commissionId: string; amount: Prisma.Decimal }[] = []
      const currency = available[0]!.currency

      for (const c of available) {
        let itemAmount = c.amount
        if (reserveActive) {
          const releasePct = new Prisma.Decimal(100 - reservePct)
          itemAmount = c.amount.mul(releasePct).div(100)
        }
        totalAmount = totalAmount.add(itemAmount)
        items.push({ commissionId: c.id, amount: itemAmount })
      }

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

      for (const item of items) {
        await tx.payoutItem.create({
          data: {
            payoutId: newPayout.id,
            commissionId: item.commissionId,
            amount: item.amount,
            isReserveRelease: false,
          },
        })
      }

      return {
        id: newPayout.id,
        amount: totalAmount,
        currency,
        itemCount: items.length,
        capturedIds,
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payout transaction failed"
    if (
      message.includes("No available commissions") ||
      message.includes("Concurrent payout") ||
      message.includes("eligibility") ||
      message.includes("; ")
    ) {
      return { success: false, error: message }
    }
    throw error
  }

  if (sendFn) {
    try {
      const result = await sendFn(
        payout.id,
        payout.amount.toString(),
        payout.currency,
        affiliate.payoutMethod
      )

      if (result.success) {
        // One internal tx with CAS predicates, persist provider identity for convergent retry
        await prisma.$transaction(async (tx) => {
          const updated = await tx.payout.updateMany({
            where: { id: payout.id, status: "PROCESSING" },
            data: {
              status: "PAID",
              providerPayoutId: result.providerPayoutId,
              paidAt: new Date(),
            },
          })
          if (updated.count === 0) {
            const existing = await tx.payout.findUnique({
              where: { id: payout.id },
              select: { status: true, providerPayoutId: true },
            })
            if (existing?.status === "PAID") {
              // Convergent retry: already finalized, ensure provider identity is persisted if missing
              if (!existing.providerPayoutId && result.providerPayoutId) {
                await tx.payout.updateMany({
                  where: { id: payout.id, status: "PAID" },
                  data: { providerPayoutId: result.providerPayoutId },
                })
              }
              logger.info("Payout already PAID — convergent retry", { payoutId: payout.id })
            }
          }

          await tx.commission.updateMany({
            where: { id: { in: payout.capturedIds }, status: "RESERVED" },
            data: { status: "PAID" },
          })
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
        // Provider failed — release ONLY captured commissions (CAS), one tx
        await prisma.$transaction(async (tx) => {
          const updated = await tx.payout.updateMany({
            where: { id: payout.id, status: "PROCESSING" },
            data: { status: "FAILED", failureCode: "PROVIDER_ERROR" },
          })
          if (updated.count === 0) return
          await tx.commission.updateMany({
            where: { id: { in: payout.capturedIds }, status: "RESERVED", affiliateId },
            data: { status: "AVAILABLE" },
          })
          await tx.payoutItem.deleteMany({ where: { payoutId: payout.id } })
        })

        logger.error("Payout provider failed", {
          payoutId: payout.id,
          providerError: result.error ?? "unknown",
        })

        return { success: false, payoutId: payout.id, error: "Provider payout failed" }
      }
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.payout.updateMany({
          where: { id: payout.id, status: "PROCESSING" },
          data: { status: "FAILED", failureCode: "PROVIDER_EXCEPTION" },
        })
        if (updated.count === 0) return
        await tx.commission.updateMany({
          where: { id: { in: payout.capturedIds }, status: "RESERVED", affiliateId },
          data: { status: "AVAILABLE" },
        })
        await tx.payoutItem.deleteMany({ where: { payoutId: payout.id } })
      })

      logger.error("Payout provider exception", {
        payoutId: payout.id,
        error: error instanceof Error ? error.message : String(error),
      })

      return { success: false, payoutId: payout.id, error: "Provider exception" }
    }
  }

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
