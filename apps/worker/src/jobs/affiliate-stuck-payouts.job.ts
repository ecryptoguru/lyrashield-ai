/**
 * Stuck PROCESSING payouts reconciliation job.
 *
 * PROCESSING older than threshold -> query provider status -> finalize or release.
 * Bounded batch (default 50) to avoid unbounded scans.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface StuckPayoutReleaseResult {
  found: number
  released: number
  finalized?: number
}

/** Default stuck threshold: 30 minutes (more aggressive than legacy 30 days, covers reconciliation). */
const DEFAULT_STUCK_THRESHOLD_MS = 30 * 60 * 1000
const DEFAULT_BATCH_SIZE = 50

export type ProviderStatus = "PAID" | "FAILED" | "PENDING" | "PROCESSING"

export async function releaseStuckProcessingPayouts(opts?: {
  thresholdMs?: number
  batchSize?: number
  getProviderStatus?: (payout: {
    id: string
    affiliateId: string
    provider: string | null
    providerPayoutId: string | null
    amount: unknown
    currency: string
  }) => Promise<{ status: ProviderStatus; providerPayoutId?: string }>
}): Promise<StuckPayoutReleaseResult> {
  const thresholdMs = opts?.thresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE
  const threshold = new Date(Date.now() - thresholdMs)

  const stuckPayouts = await prisma.payout.findMany({
    where: {
      status: "PROCESSING",
      requestedAt: { lt: threshold },
    },
    select: { id: true, affiliateId: true, requestedAt: true, provider: true, providerPayoutId: true, amount: true, currency: true },
    take: batchSize,
    orderBy: { requestedAt: "asc" },
  })

  const result: StuckPayoutReleaseResult = {
    found: stuckPayouts.length,
    released: 0,
    finalized: 0,
  }

  for (const payout of stuckPayouts) {
    try {
      let providerStatus: ProviderStatus | null = null
      let providerPayoutId: string | undefined = undefined

      if (opts?.getProviderStatus) {
        const res = await opts.getProviderStatus(payout as never)
        providerStatus = res.status
        providerPayoutId = res.providerPayoutId
      }

      if (providerStatus === "PAID") {
        // Provider confirms success -> finalize with CAS, persist provider identity
        await prisma.$transaction(async (tx) => {
          const upd = await tx.payout.updateMany({
            where: { id: payout.id, status: "PROCESSING" },
            data: {
              status: "PAID",
              providerPayoutId: providerPayoutId ?? payout.providerPayoutId ?? undefined,
              paidAt: new Date(),
            },
          })
          if (upd.count === 0) return
          const items = await tx.payoutItem.findMany({
            where: { payoutId: payout.id },
            select: { commissionId: true },
          })
          await tx.commission.updateMany({
            where: { id: { in: items.map((i) => i.commissionId) }, status: "RESERVED" },
            data: { status: "PAID" },
          })
        })
        result.finalized!++
        logger.info("Stuck PROCESSING payout finalized via provider status", {
          payoutId: payout.id,
          affiliateId: payout.affiliateId,
        })
        continue
      }

      if (providerStatus === "PENDING" || providerStatus === "PROCESSING") {
        // Still in-flight, do not release yet
        logger.info("Stuck payout still processing at provider — skipping release", {
          payoutId: payout.id,
        })
        continue
      }

      // FAILED or no provider status (fallback) -> release owned commissions only via CAS
      // For legacy behavior when no providerStatusFn and threshold is old 30d, we still release.
      // But if threshold is short and no provider check, we treat as failed after timeout.
      await prisma.$transaction(async (tx) => {
        const upd = await tx.payout.updateMany({
          where: { id: payout.id, status: "PROCESSING" },
          data: {
            status: "FAILED",
            failureCode: providerStatus === "FAILED" ? "PROVIDER_FAILED_RECONCILED" : "STUCK_PROCESSING_TIMEOUT",
            ...(providerPayoutId ? { providerPayoutId } : {}),
          },
        })
        if (upd.count === 0) return
        const items = await tx.payoutItem.findMany({
          where: { payoutId: payout.id },
          select: { commissionId: true },
        })
        await tx.commission.updateMany({
          where: { id: { in: items.map((i) => i.commissionId) }, status: "RESERVED" },
          data: { status: "AVAILABLE" },
        })
        await tx.payoutItem.deleteMany({ where: { payoutId: payout.id } })
      })

      result.released++
      logger.warn("Stuck PROCESSING payout released", {
        payoutId: payout.id,
        affiliateId: payout.affiliateId,
        requestedAt: payout.requestedAt,
      })
    } catch (error) {
      logger.error("Failed to reconcile stuck payout", {
        payoutId: payout.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (result.found > 0) {
    logger.info("Stuck payout reconciliation complete", {
      found: result.found,
      released: result.released,
      finalized: result.finalized,
    })
  }

  return result
}

// Legacy alias for backwards compat with tests that import the 30-day constant
export const STUCK_THRESHOLD_DAYS = 30
export const STUCK_THRESHOLD_MS = DEFAULT_STUCK_THRESHOLD_MS
