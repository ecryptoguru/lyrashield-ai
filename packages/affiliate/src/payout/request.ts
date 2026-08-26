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
import { env } from "@lyrashield/config"
import { createRazorpayXProvider } from "./providers/razorpayx"

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
  ) => Promise<{
    success: boolean
    pending?: boolean
    rejected?: boolean
    providerPayoutId?: string
    error?: string
  }>
}): Promise<PayoutRequestResult> {
  const { affiliateId, provider, sendFn } = params

  if (provider !== "razorpayx" && provider !== "payoneer") {
    return { success: false, error: "Payout provider is not supported" }
  }
  const admitted = provider === "razorpayx" ? env.RAZORPAYX_PAYOUT_ADMISSION === "public" : false
  if (!admitted) return { success: false, error: "Payout provider is disabled" }

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

      if (
        provider === "razorpayx" &&
        available.some((commission) => commission.currency !== "INR")
      ) {
        throw new Error("RazorpayX payouts require INR commissions")
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
        // Provider payout rails settle in currency minor units. Round each leg
        // before summing so the persisted payout equals its payout items.
        itemAmount = itemAmount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
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
      message.includes("RazorpayX payouts require INR") ||
      message.includes("eligibility") ||
      message.includes("; ")
    ) {
      return { success: false, error: message }
    }
    throw error
  }

  const providerSend =
    sendFn ?? (provider === "razorpayx" ? createRazorpayXProvider().send : undefined)
  if (providerSend) {
    let result: {
      success: boolean
      pending?: boolean
      rejected?: boolean
      providerPayoutId?: string
      error?: string
    }
    try {
      result = await providerSend(
        payout.id,
        payout.amount.toString(),
        payout.currency,
        affiliate.payoutMethod
      )
    } catch (error) {
      // A transport error is ambiguous: provider may have accepted a payment
      // after timing out. Keep capture and payout intact for reconciliation.
      await markPayoutForReconciliation(payout.id, "PROVIDER_AMBIGUOUS")
      logger.error("Payout provider outcome is ambiguous", {
        payoutId: payout.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        success: false,
        payoutId: payout.id,
        error: "Payout outcome pending reconciliation",
      }
    }

    if (result.pending) {
      await markPayoutForReconciliation(payout.id, "PROVIDER_PENDING", result.providerPayoutId)
      return { success: false, payoutId: payout.id, error: "Payout outcome pending reconciliation" }
    }

    if (result.success) {
      try {
        // One internal tx with CAS predicates, persist provider identity for convergent retry.
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
            } else {
              throw new Error("Payout is no longer eligible for finalization")
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
      } catch (error) {
        // Provider reported success. A local finalization failure must never
        // release captured commissions or make this payout eligible again.
        await markPayoutForReconciliation(
          payout.id,
          "FINALIZATION_REQUIRED",
          result.providerPayoutId
        )
        logger.error("Payout finalization requires reconciliation", {
          payoutId: payout.id,
          providerPayoutId: result.providerPayoutId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          success: false,
          payoutId: payout.id,
          error: "Payout outcome pending reconciliation",
        }
      }
    }

    if (!result.rejected) {
      await markPayoutForReconciliation(payout.id, "PROVIDER_UNCONFIRMED", result.providerPayoutId)
      return { success: false, payoutId: payout.id, error: "Payout outcome pending reconciliation" }
    }

    // Provider explicitly rejected the payout. Only this known-negative result
    // may release captured commissions.
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

  await markPayoutForReconciliation(payout.id, "PROVIDER_NOT_IMPLEMENTED")
  return { success: false, payoutId: payout.id, error: "Payout provider is unavailable" }
}

async function markPayoutForReconciliation(
  payoutId: string,
  failureCode: string,
  providerPayoutId?: string
): Promise<void> {
  try {
    await prisma.payout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: { failureCode, ...(providerPayoutId ? { providerPayoutId } : {}) },
    })
  } catch (error) {
    // Preserve the original PROCESSING record even when this diagnostic write
    // is unavailable. Eligibility excludes PROCESSING payouts, so ambiguity
    // remains fail-closed until an operator reconciles the provider reference.
    logger.error("Failed to mark payout for reconciliation", {
      payoutId,
      failureCode,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
