/**
 * Subscription synchronization.
 *
 * Maps provider subscription states to workspace plan/billing state.
 * On canceled/past_due: move workspace to read-only at period end,
 * keep data, stop paid-only scans, audit-log.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP, type CloudPlanId } from "@lyrashield/pricing"
import type { WorkspacePlan } from "@lyrashield/types"
import { grantMonthlyPool } from "./usage/grants"
import { resetGrace } from "./grace"

export type SubscriptionProvider = "polar" | "razorpay"
export type SubscriptionStatus = "active" | "canceled" | "past_due" | "trialing" | "paused" | "incomplete"
export type BillingInterval = "monthly" | "annual"

export interface SyncSubscriptionParams {
  workspaceId: string
  provider: SubscriptionProvider
  externalId: string
  plan: CloudPlanId
  status: SubscriptionStatus
  interval: BillingInterval
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  canceledAt?: Date
}

/**
 * Synchronize a subscription state from a provider webhook into the
 * workspace billing state.
 *
 * - active: update plan, grant monthly pool, reset grace
 * - canceled: keep plan until period end, then downgrade to FREE
 * - past_due: keep plan until period end, then downgrade to FREE
 * - trialing: set trial state
 *
 * All changes are audit-logged and wrapped in a single transaction so
 * the billing account, workspace plan, and audit log are committed
 * atomically.
 */
export async function syncSubscription(params: SyncSubscriptionParams): Promise<void> {
  const {
    workspaceId,
    provider,
    externalId,
    plan,
    status,
    interval,
    currentPeriodStart,
    currentPeriodEnd,
    canceledAt,
  } = params

  const cloudPlan = CLOUD_PLAN_MAP[plan]
  if (!cloudPlan) {
    logger.warn("Unknown plan in syncSubscription", { plan })
    return
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
      // Keep plan until period end, then will be downgraded
      billingStatus = "canceled"
      break
    case "past_due":
      // Keep plan until period end, then will be downgraded
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

  // Wrap all writes in a single transaction for atomicity.
  // The monthly pool grant and grace reset are called outside the transaction
  // because they perform their own independent writes with idempotency keys.
  await prisma.$transaction(async (tx) => {
    // Update billing account
    await tx.billingAccount.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider,
        externalId,
        status: billingStatus,
        currentPlan: effectivePlan,
        interval,
        currentPeriodStart: currentPeriodStart ?? null,
        currentPeriodEnd: currentPeriodEnd ?? null,
        canceledAt: canceledAt ?? null,
      },
      update: {
        provider,
        externalId,
        status: billingStatus,
        currentPlan: effectivePlan,
        interval,
        currentPeriodStart: currentPeriodStart ?? undefined,
        currentPeriodEnd: currentPeriodEnd ?? undefined,
        canceledAt: canceledAt ?? undefined,
      },
    })

    // Update workspace plan + deepAllowed
    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        plan: effectivePlan,
        deepAllowed,
      },
    })

    // Audit log
    await tx.auditLog.create({
      data: {
        workspaceId,
        action: "billing.subscription_synced",
        resourceType: "billing_account",
        resourceId: externalId,
        metadata: {
          provider,
          plan,
          status,
          interval,
          deepAllowed,
        },
      },
    })
  })

  // Grant monthly pool on active subscription (outside the transaction —
  // grantMonthlyPool and resetGrace perform their own idempotent writes).
  if (status === "active" && currentPeriodStart && cloudPlan.agentMinutes > 0) {
    const source = interval === "annual" ? "annual_monthly" : "subscription"
    await grantMonthlyPool(workspaceId, plan, currentPeriodStart, source)
    await resetGrace(workspaceId)
  }

  logger.info("Subscription synced", {
    workspaceId,
    provider,
    externalId,
    plan,
    status,
    interval,
  })
}

/**
 * Downgrade a workspace to FREE after the subscription period ends.
 *
 * Called by a scheduled job that checks for expired canceled/past_due subs.
 * Data is preserved; scans are blocked by the entitlement gate.
 */
export async function downgradeToFree(workspaceId: string, reason: string): Promise<void> {
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: "FREE",
      deepAllowed: false,
    },
  })

  await prisma.billingAccount.update({
    where: { workspaceId },
    data: {
      status: "downgraded",
      currentPlan: "FREE",
    },
  })

  await prisma.auditLog.create({
    data: {
      workspaceId,
      action: "billing.downgraded",
      resourceType: "workspace",
      resourceId: workspaceId,
      metadata: { reason },
    },
  })

  logger.info("Workspace downgraded to FREE", { workspaceId, reason })
}
