/**
 * Trial lifecycle management.
 *
 * Trials give workspaces 100 agent-minutes (one-time) and up to 3 targets
 * for 14 days. When the trial expires, the workspace enters a locked state
 * with an upgrade CTA — data is preserved, scans are blocked.
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import { grantMonthlyPool } from "./usage/grants"

/** Trial duration in days. */
export const TRIAL_DURATION_DAYS = 14

/** Trial agent-minutes (one-time grant). */
export const TRIAL_AGENT_MINUTES = 100

/** Trial target cap. */
export const TRIAL_TARGET_CAP = 3

export interface TrialState {
  /** Whether the workspace is on an active trial. */
  isActive: boolean
  /** Whether the trial has expired. */
  isExpired: boolean
  /** Trial start timestamp. */
  startedAt: Date | null
  /** Trial end timestamp. */
  endsAt: Date | null
  /** Days remaining in the trial. */
  daysLeft: number
  /** Minutes remaining (from the one-time grant). */
  minutesLeft: number
  /** Targets used so far. */
  targetsUsed: number
  /** Target cap for the trial. */
  targetCap: number
}

/**
 * Start a trial for a workspace.
 *
 * Sets trialStartedAt on the Workspace and grants 100 one-time agent-minutes.
 * Idempotent: if a trial has already started, this is a no-op.
 */
export async function startTrial(workspaceId: string): Promise<{ started: boolean; trialEndsAt: Date }> {
  const now = new Date()
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)

  // A-M01: Atomic conditional update — only sets trialStartedAt if it's still null.
  // This prevents the TOCTOU race where two concurrent requests both read null
  // and both proceed to grant trial minutes.
  const result = await prisma.workspace.updateMany({
    where: { id: workspaceId, trialStartedAt: null },
    data: {
      trialStartedAt: now,
      plan: "FREE",
      deepAllowed: false,
    },
  })

  if (result.count === 0) {
    // Trial was already started (by this call or a concurrent one)
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { trialStartedAt: true },
    })
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    const endsAt = workspace.trialStartedAt
      ? new Date(workspace.trialStartedAt.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
      : trialEndsAt
    return { started: false, trialEndsAt: endsAt }
  }

  // Update billing account
  await prisma.billingAccount.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      status: "trialing",
      currentPlan: "FREE",
      trialEndsAt,
    },
    update: {
      status: "trialing",
      currentPlan: "FREE",
      trialEndsAt,
    },
  })

  // Grant 100 one-time trial minutes
  await grantMonthlyPool(workspaceId, "TRIAL", now, "trial")

  logger.info("Trial started", { workspaceId, trialEndsAt: trialEndsAt.toISOString() })

  return { started: true, trialEndsAt }
}

/**
 * Get the current trial state for a workspace.
 */
export async function getTrialState(workspaceId: string): Promise<TrialState> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, trialStartedAt: true },
  })

  if (!workspace || !workspace.trialStartedAt) {
    return {
      isActive: false,
      isExpired: false,
      startedAt: null,
      endsAt: null,
      daysLeft: 0,
      minutesLeft: 0,
      targetsUsed: 0,
      targetCap: TRIAL_TARGET_CAP,
    }
  }

  const now = new Date()
  const endsAt = new Date(
    workspace.trialStartedAt.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
  )
  const isExpired = now > endsAt
  const daysLeft = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))

  // Get remaining minutes
  const trialPlan = CLOUD_PLAN_MAP.TRIAL
  const grantRecords = await prisma.usageRecord.findMany({
    where: {
      workspaceId,
      kind: "trial_grant",
      deletedAt: null,
    },
    select: { quantity: true },
  })
  const consumeRecords = await prisma.usageRecord.findMany({
    where: {
      workspaceId,
      kind: "agent_minutes",
      deletedAt: null,
    },
    select: { quantity: true },
  })
  const granted = grantRecords.reduce((s, r) => s + r.quantity, 0)
  const consumed = consumeRecords.reduce((s, r) => s + r.quantity, 0)
  const minutesLeft = Math.max(0, granted - consumed)

  // Get target count
  const targetsUsed = await prisma.target.count({
    where: { workspaceId, deletedAt: null },
  })

  return {
    isActive: !isExpired && workspace.plan === "FREE",
    isExpired,
    startedAt: workspace.trialStartedAt,
    endsAt,
    daysLeft,
    minutesLeft,
    targetsUsed,
    targetCap: trialPlan.targetCaps,
  }
}

/**
 * Block a workspace when its trial has expired.
 *
 * Sets billingAccount.status to "trial_expired". Data is preserved;
 * scans are blocked by assertScanAllowed.
 */
export async function blockOnExpiry(workspaceId: string): Promise<{ blocked: boolean }> {
  const trialState = await getTrialState(workspaceId)

  if (!trialState.isExpired || !trialState.startedAt) {
    return { blocked: false }
  }

  const billingAccount = await prisma.billingAccount.findUnique({
    where: { workspaceId },
    select: { id: true, status: true },
  })

  if (billingAccount?.status === "trial_expired") {
    return { blocked: false }
  }

  await prisma.billingAccount.update({
    where: { workspaceId },
    data: { status: "trial_expired" },
  })

  // A-L03: Audit log trial expiry block
  await prisma.auditLog.create({
    data: {
      workspaceId,
      action: "billing.trial_expired",
      resourceType: "workspace",
      resourceId: workspaceId,
      metadata: { trialStartedAt: trialState.startedAt },
    },
  }).catch(() => {})

  logger.info("Trial expired — workspace locked", { workspaceId })

  return { blocked: true }
}
