/**
 * Payout scheduler — `payoutScheduler()`.
 *
 * Build eligible payout batches; monthly net-30 on the 15th.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { checkPayoutEligibility } from "./eligibility"
import { requestPayout } from "./request"
import { PAYOUT_DAY_OF_MONTH } from "../index"

export interface PayoutBatch {
  affiliateId: string
  payoutId?: string
  amount?: string
  success: boolean
  error?: string
}

/**
 * Check if today is a payout day (15th of the month).
 */
export function isPayoutDay(now: Date = new Date()): boolean {
  return now.getDate() === PAYOUT_DAY_OF_MONTH
}

/**
 * Run the payout scheduler. Finds all affiliates with eligible balances
 * and processes their payouts.
 *
 * Should be called by the monthly BullMQ job on the 15th.
 */
export async function payoutScheduler(): Promise<PayoutBatch[]> {
  if (!isPayoutDay()) {
    logger.info("Payout scheduler: not a payout day, skipping", {
      day: new Date().getDate(),
      expectedDay: PAYOUT_DAY_OF_MONTH,
    })
    return []
  }

  // Find all approved affiliates
  const affiliates = await prisma.affiliate.findMany({
    where: { status: "APPROVED" },
    select: { id: true, payoutMethod: true },
  })

  const batches: PayoutBatch[] = []

  for (const affiliate of affiliates) {
    const eligibility = await checkPayoutEligibility(affiliate.id)
    if (!eligibility.eligible) {
      continue
    }

    // Determine provider from payout method
    const payoutMethod = affiliate.payoutMethod as { type?: string; country?: string } | null
    const providerType = payoutMethod?.type ?? "manual"
    const provider = providerType === "razorpayx" ? "razorpayx" :
      providerType === "payoneer" ? "payoneer" :
      providerType === "briskpe" ? "briskpe" : "manual"

    const result = await requestPayout({
      affiliateId: affiliate.id,
      provider,
    })

    batches.push({
      affiliateId: affiliate.id,
      payoutId: result.payoutId,
      amount: result.amount,
      success: result.success,
      error: result.error,
    })

    logger.info("Payout scheduler: processed affiliate", {
      affiliateId: affiliate.id,
      success: result.success,
      payoutId: result.payoutId,
    })
  }

  logger.info("Payout scheduler complete", {
    totalAffiliates: batches.length,
    successful: batches.filter((b) => b.success).length,
    failed: batches.filter((b) => !b.success).length,
  })

  return batches
}
