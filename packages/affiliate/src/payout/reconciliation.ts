/**
 * Payout reconciliation — `reconciliationJob()`.
 *
 * Compare internal commissions/payouts vs Polar/Razorpay exports.
 * Flag drift for manual review.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ReconciliationResult {
  /** Total conversions checked. */
  conversionsChecked: number
  /** Total payouts checked. */
  payoutsChecked: number
  /** Drift items found. */
  driftItems: DriftItem[]
}

export interface DriftItem {
  type: "conversion" | "payout"
  internalId: string
  externalId?: string
  issue: string
  internalAmount?: string
  externalAmount?: string
}

/**
 * Run reconciliation against provider exports.
 *
 * This is a stub that compares internal records. In production, it would
 * fetch provider exports (Polar/Razorpay) and compare line-by-line.
 */
export async function reconciliationJob(params?: {
  /** Optional provider export data for comparison. */
  polarConversions?: Array<{ externalId: string; amount: string; status: string }>
  polarPayouts?: Array<{ id: string; amount: string; status: string }>
}): Promise<ReconciliationResult> {
  const driftItems: DriftItem[] = []

  // Check internal conversions
  const conversions = await prisma.conversion.findMany({
    select: {
      id: true,
      externalId: true,
      grossAmount: true,
      commissionableAmount: true,
      currency: true,
    },
    take: 1000,
  })

  // If provider data is provided, compare
  if (params?.polarConversions) {
    const externalMap = new Map(
      params.polarConversions.map((c) => [c.externalId, c])
    )

    for (const conv of conversions) {
      const external = externalMap.get(conv.externalId)
      if (!external) {
        driftItems.push({
          type: "conversion",
          internalId: conv.id,
          externalId: conv.externalId,
          issue: "Conversion exists internally but not in provider export",
        })
      }
    }

    // Check for conversions in provider export but not internally
    const internalIds = new Set(conversions.map((c) => c.externalId))
    for (const external of params.polarConversions) {
      if (!internalIds.has(external.externalId)) {
        driftItems.push({
          type: "conversion",
          internalId: "",
          externalId: external.externalId,
          issue: "Conversion exists in provider export but not internally",
        })
      }
    }
  }

  // Check internal payouts
  const payouts = await prisma.payout.findMany({
    select: {
      id: true,
      amount: true,
      status: true,
      providerPayoutId: true,
      currency: true,
    },
    take: 1000,
  })

  if (params?.polarPayouts) {
    const externalMap = new Map(params.polarPayouts.map((p) => [p.id, p]))

    for (const payout of payouts) {
      if (!payout.providerPayoutId) continue
      const external = externalMap.get(payout.providerPayoutId)
      if (!external) {
        driftItems.push({
          type: "payout",
          internalId: payout.id,
          externalId: payout.providerPayoutId,
          issue: "Payout exists internally but not in provider export",
        })
      } else if (external.status === "PAID" && payout.status !== "PAID") {
        driftItems.push({
          type: "payout",
          internalId: payout.id,
          externalId: payout.providerPayoutId,
          issue: `Status mismatch: internal=${payout.status}, external=${external.status}`,
        })
      }
    }
  }

  logger.info("Reconciliation complete", {
    conversionsChecked: conversions.length,
    payoutsChecked: payouts.length,
    driftCount: driftItems.length,
  })

  return {
    conversionsChecked: conversions.length,
    payoutsChecked: payouts.length,
    driftItems,
  }
}
