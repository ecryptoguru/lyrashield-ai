/**
 * Trial lifecycle management.
 *
 * Trials give workspaces 100 agent-minutes (one-time) and up to 3 targets
 * for 14 days. When the trial expires, the workspace enters a locked state
 * with an upgrade CTA — data is preserved, scans are blocked.
 */

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

/** Trial duration in days. */
export const TRIAL_DURATION_DAYS = 14

/** Trial agent-minutes (one-time grant). */
export const TRIAL_AGENT_MINUTES = 100

/** Trial target cap. */
export const TRIAL_TARGET_CAP = 3

type TrialTransaction = Parameters<Parameters<typeof withWorkspaceRLS>[1]>[0]

async function hasUsedTrial(
  userId: string,
  db: Pick<TrialTransaction, "user" | "workspace">
): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { trialStartedAt: true } })
  if (!user || user.trialStartedAt) return true
  // Older application revisions may still grant trials during migration rollout.
  return Boolean(
    await db.workspace.findFirst({
      where: { trialStartedAt: { not: null }, members: { some: { userId } } },
      select: { id: true },
    })
  )
}

/** Read-only advisory eligibility. The start transaction repeats all guards. */
export async function isTrialAvailable(workspaceId: string, userId: string): Promise<boolean> {
  const [workspace, alreadyUsed] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, trialStartedAt: true },
    }),
    hasUsedTrial(userId, prisma),
  ])
  return Boolean(workspace?.plan === "FREE" && !workspace.trialStartedAt && !alreadyUsed)
}

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
 * A caller creating a workspace may supply its existing scoped transaction so
 * workspace creation, the lifetime user claim, and the grant commit together.
 */
export async function startTrial(
  workspaceId: string,
  userId: string,
  transaction?: TrialTransaction
): Promise<{ started: boolean; trialEndsAt: Date | null; alreadyUsed: boolean }> {
  const now = new Date()
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)

  const run = async (tx: TrialTransaction) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`trial:${userId}`}, 0))`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, trialStartedAt: true },
    })
    if (!workspace) throw new Error("Workspace not found")
    if (workspace.plan !== "FREE") throw new Error("TRIAL_PAID_PLAN")
    if (workspace.trialStartedAt) {
      return {
        started: false,
        alreadyUsed: false,
        trialEndsAt: new Date(
          workspace.trialStartedAt.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
        ),
      }
    }

    const alreadyUsed = await hasUsedTrial(userId, tx)
    // Also persist a legacy claim so later membership removal cannot restore eligibility.
    const claimed = await tx.user.updateMany({
      where: { id: userId, trialStartedAt: null },
      data: { trialStartedAt: now },
    })
    if (alreadyUsed || claimed.count !== 1)
      return { started: false, alreadyUsed: true, trialEndsAt: null }

    const updated = await tx.workspace.updateMany({
      where: { id: workspaceId, plan: "FREE", trialStartedAt: null },
      data: { trialStartedAt: now, deepAllowed: false },
    })
    // A concurrent paid upgrade wins; throwing rolls back the user claim too.
    if (updated.count !== 1) throw new Error("TRIAL_PAID_PLAN")
    await tx.billingAccount.upsert({
      where: { workspaceId },
      create: { workspaceId, status: "trialing", currentPlan: "FREE", trialEndsAt },
      update: { status: "trialing", currentPlan: "FREE", trialEndsAt },
    })
    await tx.usageRecord.create({
      data: {
        workspaceId,
        kind: "trial_grant",
        quantity: TRIAL_AGENT_MINUTES,
        idempotencyKey: `${workspaceId}:TRIAL`,
        cycleStart: now,
        metadata: { plan: "TRIAL", source: "trial", agentMinutes: TRIAL_AGENT_MINUTES },
      },
    })
    return { started: true, alreadyUsed: false, trialEndsAt }
  }
  const result = transaction ? await run(transaction) : await withWorkspaceRLS(workspaceId, run)

  if (result.started) {
    logger.info("Trial started", { workspaceId, trialEndsAt: result.trialEndsAt?.toISOString() })
  }

  return result
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
  const daysLeft = Math.max(
    0,
    Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  )

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
  await prisma.auditLog
    .create({
      data: {
        workspaceId,
        action: "billing.trial_expired",
        resourceType: "workspace",
        resourceId: workspaceId,
        metadata: { trialStartedAt: trialState.startedAt },
      },
    })
    .catch(() => {})

  logger.info("Trial expired — workspace locked", { workspaceId })

  return { blocked: true }
}
