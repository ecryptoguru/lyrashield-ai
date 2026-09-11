/**
 * Trial lifecycle management — account-owned.
 *
 * A trial is a once-per-account claim: 100 agent-minutes and up to 3 targets
 * for 14 days. The workspace where the trial is started keeps
 * `trialStartedAt` as the trial's display/lock state, but the minutes belong
 * to the claiming account — joining another workspace does not grant a second
 * trial and the trial pool follows the account.
 */

import { prisma, withWorkspaceRLS, type ScopedTransaction } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import { resolveAccountBilling } from "./account"
import { getUsageBalance } from "./usage/balance"

/** Trial duration in days. */
export const TRIAL_DURATION_DAYS = 14

/** Trial agent-minutes (one-time grant). */
export const TRIAL_AGENT_MINUTES = 100

/** Trial target cap. */
export const TRIAL_TARGET_CAP = 3

/** Provider label for account-owned trial marker rows (not a real provider). */
export const TRIAL_PROVIDER = "trial"

type TrialTransaction = ScopedTransaction

async function hasUsedTrial(
  userId: string,
  db: Pick<TrialTransaction, "user" | "workspace">
): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { trialStartedAt: true } })
  if (!user || user.trialStartedAt) return true
  return false
}

/** Read-only advisory eligibility. The start transaction repeats all guards. */
export async function isTrialAvailable(workspaceId: string, userId: string): Promise<boolean> {
  const [workspace, alreadyUsed, paid] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }),
    hasUsedTrial(userId, prisma),
    prisma.billingAccount.findFirst({
      where: {
        accountId: userId,
        deletedAt: null,
        currentPlan: { not: "FREE" },
        status: { in: ["active", "past_due", "canceled"] },
      },
    }),
  ])
  return Boolean(workspace && !alreadyUsed && !paid)
}

export interface TrialState {
  /** Whether the account is on an active trial. */
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
 * Start a trial on a workspace for an account.
 *
 * Sets trialStartedAt on the Workspace (trial attribution) and grants 100
 * one-time agent-minutes to the ACCOUNT. Idempotent: if the account already
 * claimed a trial (anywhere), this is a no-op.
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${userId}`}, 0))`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, trialStartedAt: true },
    })
    if (!workspace) throw new Error("Workspace not found")
    const paid = await tx.billingAccount.findFirst({
      where: {
        accountId: userId,
        deletedAt: null,
        currentPlan: { not: "FREE" },
        status: { in: ["active", "past_due", "canceled"] },
      },
    })
    if (paid) throw new Error("TRIAL_PAID_PLAN")

    const alreadyUsed = await hasUsedTrial(userId, tx)
    // Also persist a legacy claim so later membership removal cannot restore eligibility.
    const claimed = await tx.user.updateMany({
      where: { id: userId, trialStartedAt: null },
      data: { trialStartedAt: now },
    })
    if (alreadyUsed || claimed.count !== 1)
      return { started: false, alreadyUsed: true, trialEndsAt: null }

    // Trial marker row — one per account. The workspaceId is attribution: if
    // this workspace already carries another account's billing row, the trial
    // row is account-only (workspaceId NULL, purchaseWorkspaceId set).
    const existingTrial = await tx.billingAccount.findFirst({
      where: { accountId: userId, provider: TRIAL_PROVIDER, deletedAt: null },
      select: { id: true },
    })
    if (!existingTrial) {
      await tx.billingAccount.create({
        data: {
          workspaceId: null,
          purchaseWorkspaceId: workspaceId,
          accountId: userId,
          provider: TRIAL_PROVIDER,
          status: "trialing",
          currentPlan: "FREE",
          trialEndsAt,
        },
      })
    } else {
      await tx.billingAccount.update({
        where: { id: existingTrial.id },
        data: { status: "trialing", currentPlan: "FREE", trialEndsAt },
      })
    }

    await tx.usageRecord.create({
      data: {
        workspaceId,
        accountId: userId,
        kind: "trial_grant",
        quantity: TRIAL_AGENT_MINUTES,
        idempotencyKey: `${userId}:TRIAL`,
        cycleStart: now,
        metadata: {
          plan: "TRIAL",
          source: "trial",
          accountId: userId,
          agentMinutes: TRIAL_AGENT_MINUTES,
        },
      },
    })
    return { started: true, alreadyUsed: false, trialEndsAt }
  }
  const result = transaction
    ? await run(transaction)
    : await withWorkspaceRLS(workspaceId, run, { accountId: userId })

  if (result.started) {
    logger.info("Trial started", {
      workspaceId,
      accountId: userId,
      trialEndsAt: result.trialEndsAt?.toISOString(),
    })
  }

  return result
}

/**
 * Account-level trial state — the claiming account's trial window and
 * remaining trial minutes, regardless of which workspace it scans in.
 */
export async function getAccountTrialState(accountId: string): Promise<TrialState> {
  const user = await prisma.user.findUnique({
    where: { id: accountId },
    select: { trialStartedAt: true },
  })

  if (!user?.trialStartedAt) {
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
  const endsAt = new Date(user.trialStartedAt.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
  const isExpired = now > endsAt
  const daysLeft = Math.max(
    0,
    Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  )

  const balance = await getUsageBalance(accountId).catch(() => null)

  const billing = await resolveAccountBilling(accountId)
  const trialPlan = CLOUD_PLAN_MAP.TRIAL
  return {
    isActive: !isExpired && (billing?.currentPlan ?? "FREE") === "FREE",
    isExpired,
    startedAt: user.trialStartedAt,
    endsAt,
    daysLeft,
    minutesLeft: balance?.poolRemaining ?? 0,
    targetsUsed: 0,
    targetCap: trialPlan.targetCaps,
  }
}

/**
 * Get the current trial state for a workspace (attribution view).
 *
 * The workspace's trialStartedAt drives its trial UX; minutes left come from
 * the claiming account's trial pool (the trial BillingAccount row's
 * accountId), falling back to workspace-attributed records for legacy data.
 */
export async function getTrialState(
  workspaceId: string,
  prefetchedWorkspace?: { plan: string; trialStartedAt: Date | null } | null
): Promise<TrialState> {
  const workspace =
    prefetchedWorkspace !== undefined
      ? prefetchedWorkspace
      : await prisma.workspace.findUnique({
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

  // Trial minutes belong to the claiming account.
  const trialRow = await prisma.billingAccount.findFirst({
    where: { workspaceId, provider: TRIAL_PROVIDER, deletedAt: null },
    select: { accountId: true },
  })
  const claimerId = trialRow?.accountId ?? null

  const trialPlan = CLOUD_PLAN_MAP.TRIAL
  const grantWhere = claimerId
    ? { accountId: claimerId, kind: "trial_grant", deletedAt: null }
    : {
        workspaceId,
        kind: "trial_grant" as const,
        deletedAt: null,
        accountId: null as string | null,
      }
  const grantRecords = await prisma.usageRecord.findMany({
    where: grantWhere,
    select: { quantity: true },
  })
  const consumeWhere = claimerId
    ? { accountId: claimerId, kind: "agent_minutes" as const, deletedAt: null }
    : {
        workspaceId,
        kind: "agent_minutes" as const,
        deletedAt: null,
        accountId: null as string | null,
      }
  const consumeRecords = await prisma.usageRecord.findMany({
    where: consumeWhere,
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
 * Block an account when its trial has expired.
 *
 * Sets the account's trial BillingAccount status to "trial_expired". Data is
 * preserved; scans are blocked by assertScanAllowed for that sponsor.
 */
export async function blockOnExpiry(
  accountId: string,
  workspaceId?: string
): Promise<{ blocked: boolean }> {
  const trialState = await getAccountTrialState(accountId)

  if (!trialState.isExpired || !trialState.startedAt) {
    return { blocked: false }
  }

  const billingAccount = await prisma.billingAccount.findFirst({
    where: { accountId, provider: TRIAL_PROVIDER, deletedAt: null },
    select: { id: true, status: true, workspaceId: true, purchaseWorkspaceId: true },
  })

  if (!billingAccount || billingAccount.status === "trial_expired") {
    return { blocked: false }
  }

  await prisma.billingAccount.update({
    where: { id: billingAccount.id },
    data: { status: "trial_expired" },
  })

  // A-L03: Audit log trial expiry block — AuditLog.workspaceId is a required
  // FK; use the trial row's attribution or the caller's context workspace.
  const auditWorkspaceId =
    billingAccount.workspaceId ?? workspaceId ?? billingAccount.purchaseWorkspaceId
  if (auditWorkspaceId)
    await prisma.auditLog
      .create({
        data: {
          workspaceId: auditWorkspaceId,
          action: "billing.trial_expired",
          resourceType: "billing_account",
          resourceId: billingAccount.id,
          metadata: { trialStartedAt: trialState.startedAt, accountId },
        },
      })
      .catch(() => {})

  logger.info("Trial expired — account blocked from scanning", { accountId })

  return { blocked: true }
}
