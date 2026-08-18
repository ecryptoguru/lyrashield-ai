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
 *
 * C-L08: Uses cursor-based pagination to check all records, not just the
 * first 1000. The `since` parameter allows incremental reconciliation.
 */
export async function reconciliationJob(params?: {
  /** Optional provider export data for comparison. */
  polarConversions?: Array<{ externalId: string; amount: string; status: string }>
  polarPayouts?: Array<{ id: string; amount: string; status: string }>
  /** C-L08: Only check records created after this date (incremental mode). */
  since?: Date
}): Promise<ReconciliationResult> {
  const driftItems: DriftItem[] = []

  // C-L08: Paginate through all conversions using cursor-based pagination
  const conversions: Array<{
    id: string
    externalId: string
    grossAmount: unknown
    commissionableAmount: unknown
    currency: string
    occurredAt: Date
  }> = []
  let cursor: string | undefined = undefined
  const pageSize = 500
  do {
    const batch: Array<{
      id: string
      externalId: string
      grossAmount: unknown
      commissionableAmount: unknown
      currency: string
      occurredAt: Date
    }> = await prisma.conversion.findMany({
      select: {
        id: true,
        externalId: true,
        grossAmount: true,
        commissionableAmount: true,
        currency: true,
        occurredAt: true,
      },
      where: params?.since ? { occurredAt: { gte: params.since } } : undefined,
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    })
    conversions.push(...batch)
    cursor = batch.length === pageSize ? batch[batch.length - 1]!.id : undefined
  } while (cursor)

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

  // C-L08: Paginate through all payouts using cursor-based pagination
  const payouts: Array<{
    id: string
    amount: unknown
    status: string
    providerPayoutId: string | null
    currency: string
    requestedAt: Date
  }> = []
  let payoutCursor: string | undefined = undefined
  do {
    const batch: Array<{
      id: string
      amount: unknown
      status: string
      providerPayoutId: string | null
      currency: string
      requestedAt: Date
    }> = await prisma.payout.findMany({
      select: {
        id: true,
        amount: true,
        status: true,
        providerPayoutId: true,
        currency: true,
        requestedAt: true,
      },
      where: params?.since ? { requestedAt: { gte: params.since } } : undefined,
      take: pageSize,
      ...(payoutCursor ? { skip: 1, cursor: { id: payoutCursor } } : {}),
      orderBy: { id: "asc" },
    })
    payouts.push(...batch)
    payoutCursor = batch.length === pageSize ? batch[batch.length - 1]!.id : undefined
  } while (payoutCursor)

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
