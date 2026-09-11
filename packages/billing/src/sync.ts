/**
 * Subscription synchronization — account-owned.
 *
 * Maps provider subscription states to the ACCOUNT's billing state. The
 * durable subscription identity is (provider, externalId); `accountId` is the
 * owner. `workspaceId` on the row is purchase attribution only — the
 * attributed workspace's `plan`/`deepAllowed` remain display fields, never
 * the entitlement source.
 *
 * On canceled/past_due: the account keeps its plan until period end, then the
 * downgrade job moves the row to FREE. Usage, packs, overage, and grace all
 * follow the account, so canceling or switching workspaces never strands or
 * duplicates allowance.
 */

import {
  prisma,
  getSystemPrisma,
  withAccountRLS,
  withWorkspaceRLS,
  type ScopedTransaction,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP, type CloudPlanId } from "@lyrashield/pricing"
import type { WorkspacePlan } from "@lyrashield/types"
import { grantMonthlyPool } from "./usage/grants"
import { resetGrace } from "./grace"
import { resolveAllowanceCycle } from "./usage/allowance-cycle"

export type SubscriptionProvider = "polar" | "razorpay"
export type SubscriptionStatus =
  "active" | "canceled" | "past_due" | "trialing" | "paused" | "incomplete"
export type BillingInterval = "monthly" | "annual"

export interface SyncSubscriptionParams {
  /**
   * Purchase-attribution workspace (provider metadata). Optional after
   * account-ownership cutover — the durable identity is (provider,
   * externalId); the workspace is only where the row was first attributed.
   */
  workspaceId?: string | null
  /**
   * Owning account (provider metadata `accountId`, stamped by checkout).
   * When absent on an existing row, the row's persisted accountId wins.
   */
  accountId?: string | null
  provider: SubscriptionProvider
  externalId: string
  plan: CloudPlanId
  status: SubscriptionStatus
  interval: BillingInterval
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  canceledAt?: Date
  /**
   * Provider-side occurrence time of this event (Razorpay `created_at`,
   * Polar entity `modified_at`). Applied monotonically: an out-of-order
   * signed delivery older than the row's lastEventAt — or one regressing
   * currentPeriodStart — is skipped so stale events cannot resurrect a
   * prior cycle's allowance window or flip canceled -> active.
   */
  eventOccurredAt?: Date
}

/**
 * Synchronize a subscription state from a provider webhook into the
 * account's billing state.
 *
 * - active: update plan, grant the current allowance cycle's pool, reset grace
 * - canceled: keep plan until period end, then downgrade to FREE
 * - past_due: keep plan until period end, then downgrade to FREE
 * - trialing: set trial state
 */
export async function syncSubscription(params: SyncSubscriptionParams): Promise<void> {
  const {
    provider,
    externalId,
    plan,
    status,
    interval,
    currentPeriodStart,
    currentPeriodEnd,
    canceledAt,
    eventOccurredAt,
  } = params

  const cloudPlan = CLOUD_PLAN_MAP[plan]
  if (!cloudPlan) {
    logger.warn("Unknown plan in syncSubscription", { plan })
    return
  }

  if (status === "active" && cloudPlan.agentMinutes > 0 && !currentPeriodStart) {
    throw new Error("active_subscription_missing_period_start")
  }

  const workspacePlan = plan as unknown as WorkspacePlan

  // Determine the effective billing status
  let billingStatus: string
  let effectivePlan: WorkspacePlan = workspacePlan
  let deepAllowed = cloudPlan.deepAllowed

  switch (status) {
    case "active":
      billingStatus = "active"
      break
    case "trialing":
      billingStatus = "trialing"
      break
    case "canceled":
      billingStatus = "canceled"
      break
    case "past_due":
      billingStatus = "past_due"
      break
    case "paused":
      billingStatus = "paused"
      break
    case "incomplete":
      billingStatus = "incomplete"
      break
    default:
      billingStatus = status
  }

  // Resolve the durable row by subscription identity, then ownership.
  // (provider, externalId) is the contract id; accountId comes from the
  // checkout-stamped provider metadata or the persisted row. A workspace
  // match alone never transfers ownership between accounts. The lookup runs
  // under the account RLS context when the owner is known, falling back to
  // the workspace context for unmigrated legacy rows (accountId NULL).
  const selectIdentity = {
    id: true,
    accountId: true,
    workspaceId: true,
    purchaseWorkspaceId: true,
  } as const
  // A verified provider event identifies the contract globally. RLS scoped
  // lookup alone can hide an existing contract under conflicting metadata.
  const existing = await getSystemPrisma().billingAccount.findFirst({
    where: { provider, externalId, deletedAt: null },
    select: selectIdentity,
  })
  if (existing?.accountId && params.accountId && existing.accountId !== params.accountId) {
    throw new Error("subscription_account_mismatch")
  }
  const accountId = existing?.accountId ?? params.accountId ?? null
  if (!accountId) throw new Error("subscription_account_unresolved")

  const purchaseWorkspaceId = existing?.purchaseWorkspaceId ?? params.workspaceId ?? null

  const writeData = {
    provider,
    externalId,
    status: billingStatus,
    currentPlan: effectivePlan,
    interval,
    currentPeriodStart: currentPeriodStart ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
    canceledAt: canceledAt ?? null,
  }

  // Attribution: keep the row's existing workspace, else attribute the
  // metadata workspace when it is free, else record purchase provenance only.
  // Resolved inside the write transaction so the uniqueness probe and the
  // upsert share one scope.
  let attributedWorkspaceId = existing?.workspaceId ?? null

  const runSync = async (tx: ScopedTransaction): Promise<boolean> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${accountId}`}, 0))`

    // Out-of-order guard under the advisory lock: a signed delivery older
    // than the last applied event — or one regressing the period start —
    // describes state we have already moved past. Skipping prevents the
    // stale event from resurrecting a prior cycle's balance window or
    // flipping canceled -> active.
    const persisted = await tx.billingAccount.findUnique({
      where: { provider_externalId: { provider, externalId } },
      select: { currentPeriodStart: true, lastEventAt: true },
    })
    const stale =
      (eventOccurredAt !== undefined &&
        persisted?.lastEventAt !== undefined &&
        persisted.lastEventAt !== null &&
        eventOccurredAt < persisted.lastEventAt) ||
      (currentPeriodStart !== undefined &&
        persisted?.currentPeriodStart !== undefined &&
        persisted.currentPeriodStart !== null &&
        currentPeriodStart < persisted.currentPeriodStart)
    if (stale) return false

    await tx.billingAccount.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: {
        ...writeData,
        lastEventAt: eventOccurredAt ?? null,
        workspaceId: attributedWorkspaceId,
        purchaseWorkspaceId,
        accountId,
      },
      update: {
        ...writeData,
        lastEventAt: eventOccurredAt ?? undefined,
        currentPeriodStart: currentPeriodStart ?? undefined,
        currentPeriodEnd: currentPeriodEnd ?? undefined,
        canceledAt: canceledAt ?? undefined,
        ...(accountId ? { accountId } : {}),
        ...(purchaseWorkspaceId ? { purchaseWorkspaceId } : {}),
      },
    })

    // The attributed workspace mirrors the plan for display only.
    if (attributedWorkspaceId) {
      await tx.workspace.update({
        where: { id: attributedWorkspaceId },
        data: { plan: effectivePlan, deepAllowed },
      })
    }
    return true
  }

  const writeWorkspaceId = attributedWorkspaceId ?? existing?.workspaceId ?? params.workspaceId
  let applied: boolean
  if (accountId && writeWorkspaceId) {
    applied = await withWorkspaceRLS(writeWorkspaceId, runSync, { accountId })
  } else if (accountId) {
    applied = await withAccountRLS(accountId, runSync)
  } else if (writeWorkspaceId) {
    applied = await withWorkspaceRLS(writeWorkspaceId, runSync)
  } else {
    // No account and no workspace: the row cannot be written under RLS.
    throw new Error("subscription_sync_no_scope")
  }

  if (!applied) {
    logger.warn("Skipped stale subscription event", {
      provider,
      externalId,
      accountId,
      eventOccurredAt: eventOccurredAt?.toISOString() ?? null,
      currentPeriodStart: currentPeriodStart?.toISOString() ?? null,
    })
    const staleAuditWorkspaceId =
      attributedWorkspaceId ?? purchaseWorkspaceId ?? params.workspaceId ?? null
    if (staleAuditWorkspaceId) {
      try {
        await prisma.auditLog.create({
          data: {
            workspaceId: staleAuditWorkspaceId,
            action: "billing.subscription_stale_event",
            resourceType: "billing_account",
            resourceId: externalId,
            metadata: {
              provider,
              accountId,
              eventOccurredAt: eventOccurredAt?.toISOString() ?? null,
              currentPeriodStart: currentPeriodStart?.toISOString() ?? null,
            },
          },
        })
      } catch (error) {
        logger.error("Failed to create audit log", {
          workspaceId: staleAuditWorkspaceId,
          action: "billing.subscription_stale_event",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return
  }

  const auditWorkspaceId =
    attributedWorkspaceId ?? purchaseWorkspaceId ?? params.workspaceId ?? null

  if (auditWorkspaceId) {
    try {
      await prisma.auditLog.create({
        data: {
          workspaceId: auditWorkspaceId,
          action: "billing.subscription_synced",
          resourceType: "billing_account",
          resourceId: externalId,
          metadata: {
            provider,
            plan,
            status,
            interval,
            deepAllowed,
            accountId,
          },
        },
      })
    } catch (error) {
      logger.error("Failed to create audit log", {
        workspaceId: auditWorkspaceId,
        action: "billing.subscription_synced",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Grant the CURRENT allowance cycle's pool on active subscriptions.
  // For annual plans the provider period spans the term — the cycle is the
  // monthly anniversary containing now, not the term start. The
  // replenishment job owns later cycles; this covers activation/renewal.
  // A-L10: Log failures at error level so monitoring can alert.
  if (status === "active" && currentPeriodStart && cloudPlan.agentMinutes > 0 && accountId) {
    const cycle = resolveAllowanceCycle({
      interval,
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd ?? null,
    })
    const source = interval === "annual" ? "annual_monthly" : "subscription"
    const grantWorkspaceId = attributedWorkspaceId ?? null
    try {
      await grantMonthlyPool({
        accountId,
        workspaceId: grantWorkspaceId,
        plan,
        cycleStart: cycle.cycleStart,
        source,
      })
      await resetGrace(accountId)
    } catch (grantError) {
      logger.error("Monthly pool grant or grace reset failed after subscription sync", {
        accountId,
        plan,
        error: grantError instanceof Error ? grantError.message : String(grantError),
      })
      throw grantError
    }
  }

  logger.info("Subscription synced", {
    accountId,
    workspaceId: attributedWorkspaceId,
    provider,
    externalId,
    plan,
    status,
    interval,
  })
}

/**
 * Downgrade a billing account's subscription after the period ends.
 *
 * Called by the scheduled job on expired canceled/past_due rows. The
 * attributed workspace's display plan resets too; the account's usage
 * history and packs are untouched.
 */
type DowngradeIdentity =
  | {
      provider: string
      externalId: string
      accountId?: string | null
      workspaceId?: string | null
    }
  | {
      billingAccountId: string
      accountId?: string | null
      workspaceId?: string | null
    }
  | { workspaceId: string; accountId?: string | null }
  | { accountId: string; workspaceId?: string | null }

const DOWNGRADE_SELECT = {
  id: true,
  accountId: true,
  workspaceId: true,
} as const

/**
 * Resolve the billing row under the narrowest available RLS context:
 * account context when the owner is known, workspace context for legacy
 * attribution, and the privileged system client only when the caller
 * supplied a bare row identity (the worker downgrade sweep's shape).
 */
async function resolveDowngradeRow(identity: DowngradeIdentity) {
  const hints = identity as { accountId?: string | null; workspaceId?: string | null }
  const byKey = (tx: ScopedTransaction) => {
    if ("billingAccountId" in identity) {
      return tx.billingAccount.findUnique({
        where: { id: identity.billingAccountId },
        select: DOWNGRADE_SELECT,
      })
    }
    if ("provider" in identity) {
      return tx.billingAccount.findFirst({
        where: {
          provider: identity.provider,
          externalId: identity.externalId,
          deletedAt: null,
        },
        select: DOWNGRADE_SELECT,
      })
    }
    if (typeof hints.workspaceId === "string") {
      return tx.billingAccount.findUnique({
        where: { workspaceId: hints.workspaceId },
        select: DOWNGRADE_SELECT,
      })
    }
    // Account-level identity (e.g. Polar customer.state_changed with only
    // customer metadata): pick the account's live subscription row.
    return tx.billingAccount.findFirst({
      where: {
        accountId: hints.accountId ?? undefined,
        deletedAt: null,
        status: { in: ["active", "trialing", "canceled", "past_due"] },
      },
      orderBy: { currentPeriodEnd: "desc" },
      select: DOWNGRADE_SELECT,
    })
  }
  // The account context resolves an account-owned row even when its
  // workspace attribution moved or was cleared — prefer it when present.
  if (hints.accountId) return withAccountRLS(hints.accountId, byKey)
  if (hints.workspaceId) return withWorkspaceRLS(hints.workspaceId, byKey)
  // No context hint: only the worker's privileged sweep calls this shape.
  const system = getSystemPrisma()
  if ("billingAccountId" in identity) {
    return system.billingAccount.findUnique({
      where: { id: identity.billingAccountId },
      select: DOWNGRADE_SELECT,
    })
  }
  if ("provider" in identity) {
    return system.billingAccount.findFirst({
      where: { provider: identity.provider, externalId: identity.externalId, deletedAt: null },
      select: DOWNGRADE_SELECT,
    })
  }
  if (typeof hints.workspaceId === "string") {
    return system.billingAccount.findUnique({
      where: { workspaceId: hints.workspaceId },
      select: DOWNGRADE_SELECT,
    })
  }
  return system.billingAccount.findFirst({
    where: { accountId: hints.accountId ?? undefined, deletedAt: null },
    orderBy: { currentPeriodEnd: "desc" },
    select: DOWNGRADE_SELECT,
  })
}

export async function downgradeToFree(identity: DowngradeIdentity, reason: string): Promise<void> {
  const row = await resolveDowngradeRow(identity)
  if (!row) return

  const apply = async (tx: ScopedTransaction) => {
    await tx.billingAccount.update({
      where: { id: row.id },
      // Participates in the monotonic event clock: a provider delivery that
      // occurred before this internal decision must not re-activate the row.
      data: { status: "downgraded", currentPlan: "FREE", lastEventAt: new Date() },
    })
    if (row.workspaceId) {
      await tx.workspace.update({
        where: { id: row.workspaceId },
        data: { plan: "FREE", deepAllowed: false },
      })
    }
  }

  if (row.accountId && row.workspaceId) {
    await withWorkspaceRLS(row.workspaceId, apply, { accountId: row.accountId })
  } else if (row.accountId) {
    await withAccountRLS(row.accountId, apply)
  } else if (row.workspaceId) {
    await withWorkspaceRLS(row.workspaceId, apply)
  } else {
    return
  }

  if (row.workspaceId) {
    try {
      await prisma.auditLog.create({
        data: {
          workspaceId: row.workspaceId,
          action: "billing.downgraded",
          resourceType: "billing_account",
          resourceId: row.id,
          metadata: { reason, accountId: row.accountId },
        },
      })
    } catch (error) {
      logger.error("Failed to create audit log", {
        workspaceId: row.workspaceId,
        action: "billing.downgraded",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logger.info("Subscription downgraded to FREE", {
    billingAccountId: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    reason,
  })
}
