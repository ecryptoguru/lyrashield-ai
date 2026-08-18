/**
 * Overage debit logic.
 *
 * Team plan workspaces can opt into overage: when pool + packs are exhausted,
 * additional agent-minutes are billed at $0.15/min (STANDARD_OVERAGE_PER_MINUTE_USD),
 * up to a spend limit set by the billing admin (spendLimitCents on BillingAccount).
 *
 * Overages are tracked as UsageRecord with kind="overage_minutes".
 * The actual charge is processed by the provider (Polar/Razorpay) — this
 * module only tracks the minute consumption and checks the spend limit.
 *
 * All money is in integer cents (Decimal-safe, never Float).
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { STANDARD_OVERAGE_PER_MINUTE_USD } from "@lyrashield/pricing"

export interface DebitOverageResult {
  /** Whether the overage was debited (false = limit reached or not opted in). */
  debited: boolean
  /** Minutes debited as overage. */
  minutes: number
  /** Estimated cost in cents (for spend-limit tracking). */
  estimatedCostCents: number
  /** Reason if not debited. */
  reason?: string
}

/** Overage rate per minute in cents (from $0.15). */
const OVERAGE_PER_MINUTE_CENTS = Math.round(STANDARD_OVERAGE_PER_MINUTE_USD * 100)

/**
 * Debit overage minutes for a workspace.
 *
 * Only Team plan workspaces with a spend limit > 0 are eligible.
 * The spend limit is checked against the cumulative overage cost
 * for the current billing cycle.
 *
 * @param minutes - Minutes to debit as overage
 * @param scanId  - Scan ID for the idempotency key
 * @param phase   - Phase label for the idempotency key
 */
export async function debitOverage(
  workspaceId: string,
  minutes: number,
  scanId: string,
  phase: string
): Promise<DebitOverageResult> {
  if (minutes <= 0) {
    return { debited: false, minutes: 0, estimatedCostCents: 0, reason: "no_minutes" }
  }

  const billingAccount = await prisma.billingAccount.findUnique({
    where: { workspaceId },
    select: {
      currentPlan: true,
      spendLimitCents: true,
      currentPeriodStart: true,
    },
  })

  // Only Team plan can use overage
  if (!billingAccount || billingAccount.currentPlan !== "TEAM") {
    return {
      debited: false,
      minutes: 0,
      estimatedCostCents: 0,
      reason: "overage_not_available",
    }
  }

  // Spend limit must be set (opt-in)
  if (!billingAccount.spendLimitCents || billingAccount.spendLimitCents <= 0) {
    return {
      debited: false,
      minutes: 0,
      estimatedCostCents: 0,
      reason: "no_spend_limit",
    }
  }

  // Calculate current cycle overage cost
  const cycleStart = billingAccount.currentPeriodStart ?? new Date(0)
  const overageRecords = await prisma.usageRecord.findMany({
    where: {
      workspaceId,
      kind: "overage_minutes",
      deletedAt: null,
      cycleStart: { gte: cycleStart },
    },
    select: { quantity: true },
  })
  const currentOverageMinutes = overageRecords.reduce((sum, r) => sum + r.quantity, 0)
  const currentOverageCostCents = currentOverageMinutes * OVERAGE_PER_MINUTE_CENTS

  const requestedCostCents = minutes * OVERAGE_PER_MINUTE_CENTS
  const projectedCostCents = currentOverageCostCents + requestedCostCents

  // Check spend limit
  if (projectedCostCents > billingAccount.spendLimitCents) {
    const remainingBudgetCents = billingAccount.spendLimitCents - currentOverageCostCents
    const allowedMinutes = Math.floor(remainingBudgetCents / OVERAGE_PER_MINUTE_CENTS)
    if (allowedMinutes <= 0) {
      return {
        debited: false,
        minutes: 0,
        estimatedCostCents: 0,
        reason: "spend_limit_reached",
      }
    }
    // Debit only the allowed minutes
    minutes = allowedMinutes
  }

  const idempotencyKey = `${workspaceId}:${scanId}:${phase}:overage`

  const existing = await prisma.usageRecord.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  })
  if (existing) {
    return { debited: false, minutes: 0, estimatedCostCents: 0, reason: "idempotent_replay" }
  }

  try {
    await prisma.usageRecord.create({
      data: {
        workspaceId,
        kind: "overage_minutes",
        quantity: minutes,
        idempotencyKey,
        cycleStart: billingAccount.currentPeriodStart ?? null,
        metadata: {
          scanId,
          phase,
          costCents: minutes * OVERAGE_PER_MINUTE_CENTS,
          rateCentsPerMinute: OVERAGE_PER_MINUTE_CENTS,
        },
      },
    })
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return { debited: false, minutes: 0, estimatedCostCents: 0, reason: "idempotent_replay" }
    }
    throw error
  }

  logger.info("Debited overage minutes", {
    workspaceId,
    minutes,
    costCents: minutes * OVERAGE_PER_MINUTE_CENTS,
  })

  return {
    debited: true,
    minutes,
    estimatedCostCents: minutes * OVERAGE_PER_MINUTE_CENTS,
  }
}
