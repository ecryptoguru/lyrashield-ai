/**
 * Grace period state machine — account-owned.
 *
 * When a scan's agent-minute balance hits 0 mid-scan, the sponsoring account
 * enters a grace period of 15 minutes (wall-clock). During grace, the scan
 * continues running. If grace is exceeded, the scan is stopped with
 * STOPPED_BUDGET.
 *
 * Grace resets on allowance-cycle rollover.
 *
 * State is tracked on the account's governing BillingAccount row:
 * - graceUsedMs: cumulative grace used in the current cycle
 * - graceCycleStart: when the current grace cycle started
 *
 * (Grace was previously a Workspace counter; under account-owned billing the
 * budget must follow the paying account, not a shared workspace.)
 */

import { prisma, withAccountRLS, type ScopedTransaction } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { resolveAccountBilling, type ResolvedAccountBilling } from "./account"

/** Maximum grace period per billing cycle, in milliseconds. */
export const GRACE_CAP_MS = 15 * 60 * 1000 // 15 minutes

export interface GraceState {
  /** Whether the account is currently in a grace period. */
  inGrace: boolean
  /** Grace milliseconds used in the current cycle. */
  usedMs: number
  /** Grace milliseconds remaining in the current cycle. */
  remainingMs: number
  /** When the current grace cycle started. */
  cycleStart: Date | null
  /** Whether grace has been exceeded. */
  exceeded: boolean
}

type DbTx = ScopedTransaction

/**
 * Get the current grace state for an account.
 *
 * `prefetched` lets a caller that already resolved the account's governing
 * BillingAccount pass it in — see UsageBalancePrefetched (Deep Review v16 2.1).
 */
export async function getGraceState(
  accountId: string,
  prefetched?: ResolvedAccountBilling | null
): Promise<GraceState> {
  const billing = prefetched !== undefined ? prefetched : await resolveAccountBilling(accountId)

  if (!billing) {
    return {
      inGrace: false,
      usedMs: 0,
      remainingMs: GRACE_CAP_MS,
      cycleStart: null,
      exceeded: false,
    }
  }

  const usedMs = billing.graceUsedMs
  const remainingMs = Math.max(0, GRACE_CAP_MS - usedMs)
  const exceeded = usedMs >= GRACE_CAP_MS

  return {
    inGrace: usedMs > 0 && !exceeded,
    usedMs,
    remainingMs,
    cycleStart: billing.graceCycleStart,
    exceeded,
  }
}

/**
 * Enter or continue a grace period for an account.
 *
 * Called by the worker when the sponsor's balance <= 0 mid-scan. Returns
 * whether the scan should continue (grace available) or stop (grace
 * exceeded).
 *
 * Uses an atomic increment to avoid the read-then-write race condition
 * where concurrent ticks could both read the same graceUsedMs and overwrite
 * each other's increment.
 *
 * @param accountId - The sponsoring account (User.id)
 * @param deltaMs   - Grace milliseconds consumed in this tick
 * @returns Whether the scan should continue
 */
export async function enterGrace(
  accountId: string,
  deltaMs: number,
  transaction?: DbTx
): Promise<{ shouldContinue: boolean; remainingMs: number }> {
  // A-L06: Validate input bounds — reject negative or oversized deltaMs.
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { shouldContinue: false, remainingMs: 0 }
  }
  // Cap single-tick delta at the grace cap itself (15 minutes)
  const cappedDelta = Math.min(deltaMs, GRACE_CAP_MS)

  const apply = async (db: DbTx | typeof prisma) => {
    const billing = await resolveAccountBilling(accountId, db)
    if (!billing) return { shouldContinue: false, remainingMs: 0 }

    // A-M09: conditional updateMany checks the cap atomically — concurrent
    // ticks cannot each increment past it.
    const result = await db.billingAccount
      .updateMany({
        where: {
          id: billing.id,
          graceUsedMs: { lt: GRACE_CAP_MS },
        },
        data: {
          graceUsedMs: { increment: cappedDelta },
        },
      })
      .catch((error) => {
        if (transaction) throw error
        return { count: 0 }
      })

    if (result.count === 0) {
      return { shouldContinue: false, remainingMs: 0 }
    }

    const updated = await db.billingAccount.findUnique({
      where: { id: billing.id },
      select: { graceUsedMs: true, graceCycleStart: true, workspaceId: true },
    })
    if (!updated) return { shouldContinue: false, remainingMs: 0 }

    // Ensure graceCycleStart is set if it was null (first grace entry).
    if (!updated.graceCycleStart) {
      await db.billingAccount.updateMany({
        where: { id: billing.id, graceCycleStart: null },
        data: { graceCycleStart: new Date() },
      })
    }

    const newUsedMs = updated.graceUsedMs
    if (newUsedMs >= GRACE_CAP_MS) {
      await db.billingAccount
        .update({
          where: { id: billing.id },
          data: { graceUsedMs: GRACE_CAP_MS },
        })
        .catch((error) => {
          if (transaction) throw error
        })

      // A-L03: Audit log grace exhaustion — outside the settlement
      // transaction (the extended audit client must never nest inside it).
      // AuditLog.workspaceId is a required FK: use the billing row's
      // attribution (or purchase) workspace; skip the row when neither exists
      // rather than writing an invalid reference.
      const auditWorkspaceId = updated.workspaceId ?? billing.purchaseWorkspaceId
      if (!transaction && auditWorkspaceId)
        await prisma.auditLog
          .create({
            data: {
              workspaceId: auditWorkspaceId,
              action: "billing.grace_exceeded",
              resourceType: "billing_account",
              resourceId: billing.id,
              metadata: { graceUsedMs: GRACE_CAP_MS, accountId },
            },
          })
          .catch(() => {})

      logger.warn("Grace period exceeded — scan should stop", {
        accountId,
        graceUsedMs: GRACE_CAP_MS,
      })

      return { shouldContinue: false, remainingMs: 0 }
    }

    return {
      shouldContinue: true,
      remainingMs: GRACE_CAP_MS - newUsedMs,
    }
  }

  if (transaction) return apply(transaction)
  return withAccountRLS(accountId, (tx) => apply(tx))
}

/**
 * Reset grace for a new allowance cycle.
 *
 * Called when the account's subscription renews into a new term.
 */
export async function resetGrace(accountId: string, transaction?: DbTx): Promise<void> {
  const db = transaction ?? prisma
  const billing = await resolveAccountBilling(accountId, db)
  if (!billing) return
  // `accountId` in the where keeps the write account-scoped even when this
  // runs outside a bound transaction — the extension binds the account RLS
  // context from the explicit filter.
  await db.billingAccount.updateMany({
    where: { id: billing.id, accountId },
    data: { graceUsedMs: 0, graceCycleStart: null },
  })

  logger.info("Grace period reset for new cycle", { accountId })
}
