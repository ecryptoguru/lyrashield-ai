/**
 * Payout eligibility check.
 *
 * available >= $100 AND payout method valid AND tax form complete
 * AND no active payout lock.
 */

import { Prisma } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { env } from "@lyrashield/config"

export interface PayoutEligibility {
  eligible: boolean
  /** Available balance in major currency units. */
  availableAmount: string
  /** Minimum payout threshold in major currency units. */
  minPayout: string
  reasons: string[]
}

/**
 * Check if an affiliate is eligible to request a payout.
 */
export async function checkPayoutEligibility(affiliateId: string): Promise<PayoutEligibility> {
  const reasons: string[] = []

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    select: {
      id: true,
      payoutMethod: true,
      reservePct: true,
      reserveUntil: true,
      payoutMethodVerifiedAt: true,
      taxFormStatus: true,
    },
  })

  if (!affiliate) {
    return {
      eligible: false,
      availableAmount: "0",
      minPayout: "0",
      reasons: ["Affiliate not found"],
    }
  }

  // Sum AVAILABLE commissions
  const result = await prisma.commission.aggregate({
    where: {
      affiliateId,
      status: "AVAILABLE",
    },
    _sum: { amount: true },
  })

  const available = result._sum.amount ?? new Prisma.Decimal(0)
  const minPayout = new Prisma.Decimal(env.AFFILIATE_PAYOUT_MIN_CENTS / 100)

  // Check minimum
  if (available.lt(minPayout)) {
    reasons.push(
      `Available balance (${available.toString()}) is below minimum payout (${minPayout.toString()})`
    )
  }

  // Check payout method
  const payoutMethod = affiliate.payoutMethod as {
    type?: string
    valid?: boolean
  } | null

  if (!payoutMethod || !payoutMethod.type) {
    reasons.push("No payout method configured")
  } else if (!affiliate.payoutMethodVerifiedAt || payoutMethod.valid !== true) {
    reasons.push("Payout method is not valid")
  }

  if (payoutMethod?.type === "razorpayx" && env.RAZORPAYX_PAYOUT_ADMISSION !== "public") {
    reasons.push("RazorpayX payouts are disabled")
  } else if (payoutMethod?.type === "payoneer") {
    reasons.push("Payoneer payouts are not approved")
  }

  // Check tax form
  if (affiliate.taxFormStatus !== "VERIFIED") {
    reasons.push("Tax form not complete (W-9/W-8BEN/W-8BEN-E required, or GSTIN for India)")
  }

  // Check no active payout lock (pending/processing payouts)
  const activePayouts = await prisma.payout.count({
    where: {
      affiliateId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  })

  if (activePayouts > 0) {
    reasons.push("An active payout is already in progress")
  }

  return {
    eligible: reasons.length === 0,
    availableAmount: available.toString(),
    minPayout: minPayout.toString(),
    reasons,
  }
}
