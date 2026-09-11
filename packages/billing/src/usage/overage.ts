/**
 * Overage debit logic — account-owned.
 *
 * Launch Assurance accounts can opt into overage: when pool + packs are
 * exhausted, additional agent-minutes are billed at $0.15/min
 * (STANDARD_OVERAGE_PER_MINUTE_USD), up to a spend limit set by the billing
 * admin (spendLimitCents on the account's BillingAccount).
 *
 * Overages are tracked as UsageRecord with kind="overage_minutes" scoped to
 * the sponsoring account. The actual charge is processed by the provider
 * (Polar/Razorpay) — this module only tracks the minute consumption and
 * checks the spend limit.
 *
 * All money is in integer cents (Decimal-safe, never Float).
 */

import { withAccountRLS, type ScopedTransaction } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { STANDARD_OVERAGE_PER_MINUTE_USD } from "@lyrashield/pricing"
import { resolveAccountBilling } from "../account"
import { resolveAllowanceCycle } from "./allowance-cycle"

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
const MAX_TRANSACTION_ATTEMPTS = 3
type BillingTransaction = ScopedTransaction

function hasPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}

export interface DebitOverageInput {
  /** Owning account (sponsor) — resolved by the caller from trusted state. */
  accountId: string
  /** Attribution workspace for the usage record. */
  workspaceId: string
  minutes: number
  scanId: string
  phase: string
  /** Caller-owned transaction already bound to the account context. */
  transaction?: BillingTransaction
}

/**
 * Debit overage minutes for an account.
 *
 * Only Launch Assurance accounts with a spend limit > 0 are eligible. The
 * spend limit is checked against the cumulative overage cost for the
 * account's current allowance cycle.
 */
export async function debitOverage(input: DebitOverageInput): Promise<DebitOverageResult> {
  const { accountId, workspaceId, minutes, scanId, phase, transaction } = input
  if (minutes <= 0) {
    return { debited: false, minutes: 0, estimatedCostCents: 0, reason: "no_minutes" }
  }

  const idempotencyKey = `${workspaceId}:${scanId}:${phase}:overage`
  let debitResult: { minutes: number; replayed: boolean } | null = null
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      const apply = async (tx: BillingTransaction) => {
        // Serialize overage decisions per account.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${accountId}`}, 0))`
        const existing = await tx.usageRecord.findUnique({
          where: { idempotencyKey },
          select: { id: true, quantity: true },
        })
        if (existing) return { minutes: existing.quantity, replayed: true }

        const billingAccount = await resolveAccountBilling(accountId, tx)
        if (!billingAccount || billingAccount.effectivePlan !== "LAUNCH_ASSURANCE")
          throw new Error("overage_not_available")
        if (!billingAccount.spendLimitCents || billingAccount.spendLimitCents <= 0)
          throw new Error("no_spend_limit")

        const cycleStart = billingAccount.currentPeriodStart
          ? resolveAllowanceCycle({
              interval: billingAccount.interval,
              periodStart: billingAccount.currentPeriodStart,
              periodEnd: billingAccount.currentPeriodEnd,
            }).cycleStart
          : new Date(0)
        const overageRecords = await tx.usageRecord.findMany({
          where: {
            accountId,
            kind: "overage_minutes",
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          select: { quantity: true },
        })
        const currentOverageMinutes = overageRecords.reduce((sum, r) => sum + r.quantity, 0)
        const remainingBudgetCents =
          billingAccount.spendLimitCents - currentOverageMinutes * OVERAGE_PER_MINUTE_CENTS
        const allowedMinutes = Math.min(
          minutes,
          Math.floor(remainingBudgetCents / OVERAGE_PER_MINUTE_CENTS)
        )
        if (allowedMinutes <= 0) throw new Error("spend_limit_reached")

        await tx.usageRecord.create({
          data: {
            workspaceId,
            accountId,
            kind: "overage_minutes",
            quantity: allowedMinutes,
            idempotencyKey,
            cycleStart: billingAccount.currentPeriodStart ?? null,
            metadata: {
              scanId,
              phase,
              accountId,
              costCents: allowedMinutes * OVERAGE_PER_MINUTE_CENTS,
              rateCentsPerMinute: OVERAGE_PER_MINUTE_CENTS,
            },
          },
        })
        return { minutes: allowedMinutes, replayed: false }
      }
      debitResult = transaction
        ? await apply(transaction)
        : await withAccountRLS(accountId, apply, { isolationLevel: "Serializable" })
      break
    } catch (error) {
      // The outer meter owns retries when sharing its transaction.
      if (transaction && (hasPrismaCode(error, "P2034") || hasPrismaCode(error, "P2002")))
        throw error
      if (hasPrismaCode(error, "P2034") && attempt < MAX_TRANSACTION_ATTEMPTS) continue
      if (hasPrismaCode(error, "P2002"))
        return { debited: false, minutes: 0, estimatedCostCents: 0, reason: "idempotent_replay" }
      const reason = error instanceof Error ? error.message : ""
      if (["overage_not_available", "no_spend_limit", "spend_limit_reached"].includes(reason)) {
        return { debited: false, minutes: 0, estimatedCostCents: 0, reason }
      }
      throw error
    }
  }

  if (!debitResult) throw new Error("overage_transaction_retry_exhausted")
  const debitedMinutes = debitResult.minutes

  if (!transaction)
    logger.info("Debited overage minutes", {
      accountId,
      workspaceId,
      minutes: debitedMinutes,
      costCents: debitedMinutes * OVERAGE_PER_MINUTE_CENTS,
    })

  return {
    debited: true,
    minutes: debitedMinutes,
    estimatedCostCents: debitedMinutes * OVERAGE_PER_MINUTE_CENTS,
    ...(debitResult.replayed ? { reason: "idempotent_replay" } : {}),
  }
}
