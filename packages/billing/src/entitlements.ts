/**
 * Entitlement checks — the gate between billing state and scan/feature access.
 *
 * Subscriptions are account-owned: every check evaluates the SPONSORING
 * ACCOUNT (`sponsorAccountId` — the authenticated user for direct actions,
 * the recorded creator for scheduled/delegated work), never the workspace's
 * billing row. `workspaceId` scopes the resource, not the payer.
 */

import { prisma, type ScopedTransaction } from "@lyrashield/db"
import { CLOUD_PLAN_MAP, STANDARD_OVERAGE_PER_MINUTE_USD } from "@lyrashield/pricing"
import type { ScanMode } from "@lyrashield/types"
import { resolveAccountBilling, type ResolvedAccountBilling } from "./account"
import { getUsageBalance, getUsageBalanceForTx, resolveBalanceCycleStart } from "./usage/balance"
import { getAccountTrialState, blockOnExpiry, type TrialState } from "./trial"
import { getGraceState as getGraceStateFromGrace } from "./grace"

export type ScanModeAllowed = "SAFE" | "QUICK" | "STANDARD" | "DEEP" | "CUSTOM"

export interface EntitlementResult {
  allowed: boolean
  /** Reason code if not allowed. */
  code?: string
  /** Human-readable message if not allowed. */
  message?: string
  /** Whether the sponsoring account is on an active trial. */
  isTrial: boolean
  /** The sponsoring account's current plan. */
  plan: string
  /** Remaining minutes on the sponsoring account. */
  remainingMinutes: number
  /** The sponsoring account evaluated. */
  accountId: string
}

type DbTx = ScopedTransaction

export interface ScanEntitlementInput {
  /** Resource workspace (target must live here). */
  workspaceId: string
  mode: ScanMode
  /**
   * The account whose subscription and balance pay for this scan — the
   * authenticated user for direct actions, or the recorded creator for
   * scheduled/delegated work. Required: a missing sponsor fails closed.
   */
  sponsorAccountId: string | null | undefined
  /**
   * Read-only by default: the POST path opts into the lazy billing-account
   * status write on trial expiry. The advisory preflight
   * (GET /api/scans/eligibility) must never mutate state.
   */
  mutateOnTrialExpiry?: boolean
  /** Caller-owned transaction — must already carry the account context. */
  tx?: DbTx
}

interface SponsorContext {
  billing: ResolvedAccountBilling | null
  trial: TrialState
}

async function loadSponsorContext(sponsorAccountId: string, tx?: DbTx): Promise<SponsorContext> {
  if (tx) {
    const [billing, user] = await Promise.all([
      resolveAccountBilling(sponsorAccountId, tx),
      tx.user.findUnique({
        where: { id: sponsorAccountId },
        select: { trialStartedAt: true },
      }),
    ])
    return {
      billing,
      trial: await accountTrialStateFrom(sponsorAccountId, user?.trialStartedAt ?? null, tx),
    }
  }
  const [billing, trial] = await Promise.all([
    resolveAccountBilling(sponsorAccountId),
    getAccountTrialState(sponsorAccountId),
  ])
  return { billing, trial }
}

async function accountTrialStateFrom(
  accountId: string,
  trialStartedAt: Date | null,
  tx: DbTx
): Promise<TrialState> {
  const now = new Date()
  const endsAt = trialStartedAt
    ? new Date(trialStartedAt.getTime() + 14 * 24 * 60 * 60 * 1000)
    : null
  const isExpired = Boolean(endsAt && now > endsAt)
  if (!trialStartedAt) {
    return {
      isActive: false,
      isExpired: false,
      startedAt: null,
      endsAt: null,
      daysLeft: 0,
      minutesLeft: 0,
      targetsUsed: 0,
      targetCap: 3,
    }
  }
  const billing = await resolveAccountBilling(accountId, tx)
  const balance = await getUsageBalanceForTx(tx, {
    accountId,
    billing,
    trialStartedAt,
  })
  return {
    isActive: !isExpired && (billing?.effectivePlan ?? "FREE") === "FREE",
    isExpired,
    startedAt: trialStartedAt,
    endsAt,
    daysLeft: Math.max(0, Math.ceil(((endsAt?.getTime() ?? 0) - now.getTime()) / 86_400_000)),
    minutesLeft: balance.poolRemaining,
    targetsUsed: 0,
    targetCap: 3,
  }
}

/**
 * Evaluate whether a scan with the given mode is allowed, billed to the
 * sponsoring account.
 *
 * Rules:
 * - DEEP/CUSTOM scans require the sponsor's plan to allow deep (PRO and above)
 * - The sponsor must have remaining agent-minutes > 0 (or overage budget)
 * - Trial accounts scan while their account trial is active
 */
export async function evaluateScanEntitlement(
  input: ScanEntitlementInput
): Promise<EntitlementResult> {
  const { workspaceId, mode, sponsorAccountId, tx } = input

  if (!sponsorAccountId) {
    return {
      allowed: false,
      code: "SPONSOR_REQUIRED",
      message: "No sponsoring account could be resolved for this scan.",
      isTrial: false,
      plan: "FREE",
      remainingMinutes: 0,
      accountId: "",
    }
  }

  const workspace = await (tx ?? prisma).workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  })

  if (!workspace) {
    return {
      allowed: false,
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found",
      isTrial: false,
      plan: "FREE",
      remainingMinutes: 0,
      accountId: sponsorAccountId,
    }
  }

  const { billing, trial: trialState } = await loadSponsorContext(sponsorAccountId, tx)

  // Entitlement uses the effective plan: a canceled/past_due row past its
  // paid term entitles as FREE immediately — no wait on the downgrade job.
  const plan = billing?.effectivePlan ?? "FREE"
  const cloudPlan = CLOUD_PLAN_MAP[plan as keyof typeof CLOUD_PLAN_MAP]
  const isTrial = trialState.isActive

  // Trial expiry: block + (on the POST path) lazily record the status.
  if (trialState.isExpired) {
    if (input.mutateOnTrialExpiry) {
      await blockOnExpiry(sponsorAccountId, workspaceId).catch(() => {})
    }
    return {
      allowed: false,
      code: "TRIAL_EXPIRED",
      message: "Your trial has expired. Upgrade to continue scanning.",
      isTrial,
      plan,
      remainingMinutes: 0,
      accountId: sponsorAccountId,
    }
  }

  // Deep scan permission comes from the sponsor's plan.
  const isDeepMode = mode === "DEEP" || mode === "CUSTOM"
  if (isDeepMode && !(cloudPlan?.deepAllowed ?? false)) {
    return {
      allowed: false,
      code: "DEEP_NOT_ALLOWED",
      message:
        "Deep is a Pro feature. Upgrade to Pro or Launch Assurance to run Deep/Custom scans.",
      isTrial,
      plan,
      remainingMinutes: 0,
      accountId: sponsorAccountId,
    }
  }

  // Account balance — the sponsor's pool + packs across all workspaces.
  const balance = tx
    ? await getUsageBalanceForTx(tx, {
        accountId: sponsorAccountId,
        billing,
        trialStartedAt: trialState.startedAt,
      })
    : await getUsageBalance(sponsorAccountId, { billing, trialStartedAt: trialState.startedAt })

  if (balance.totalRemaining <= 0) {
    // Overage is available only to Launch Assurance accounts with a limit.
    const overagePlanEligible =
      billing?.effectivePlan === "LAUNCH_ASSURANCE" && (billing.spendLimitCents ?? 0) > 0

    if (overagePlanEligible && billing) {
      const cycleStart =
        resolveBalanceCycleStart({
          billing,
          trialStartedAt: trialState.startedAt,
        }) ?? new Date(0)
      const overageAggregate = await (tx ?? prisma).usageRecord.aggregate({
        where: {
          accountId: sponsorAccountId,
          kind: "overage_minutes",
          deletedAt: null,
          cycleStart: { gte: cycleStart },
        },
        _sum: { quantity: true },
      })
      const currentOverageMinutes = overageAggregate._sum.quantity ?? 0
      const overagePerMinuteCents = Math.round(STANDARD_OVERAGE_PER_MINUTE_USD * 100)
      const remainingBudgetCents =
        (billing.spendLimitCents ?? 0) - currentOverageMinutes * overagePerMinuteCents

      if (remainingBudgetCents <= 0) {
        return {
          allowed: false,
          code: "NO_MINUTES_REMAINING",
          message:
            "Your agent-minute balance is exhausted and your overage spend limit has been reached. Buy a minute pack or upgrade your plan.",
          isTrial,
          plan,
          remainingMinutes: 0,
          accountId: sponsorAccountId,
        }
      }
    } else {
      return {
        allowed: false,
        code: "NO_MINUTES_REMAINING",
        message: isTrial
          ? "Your trial minutes are exhausted. Upgrade to continue scanning."
          : "Your agent-minute balance is exhausted. Buy a minute pack or upgrade your plan.",
        isTrial,
        plan,
        remainingMinutes: 0,
        accountId: sponsorAccountId,
      }
    }
  }

  return {
    allowed: true,
    isTrial,
    plan,
    remainingMinutes: balance.totalRemaining,
    accountId: sponsorAccountId,
  }
}

/**
 * Assert that a scan with the given mode is allowed for the sponsoring
 * account in this workspace.
 *
 * Authoritative POST-side gate: on trial expiry it also lazily records the
 * billing-account status. See `evaluateScanEntitlement` for the rules.
 */
export async function assertScanAllowed(
  workspaceId: string,
  mode: ScanMode,
  sponsorAccountId: string | null | undefined,
  tx?: DbTx
): Promise<EntitlementResult> {
  return evaluateScanEntitlement({
    workspaceId,
    mode,
    sponsorAccountId,
    mutateOnTrialExpiry: true,
    tx,
  })
}

export interface TargetAllowedResult {
  allowed: boolean
  code?: string
  message?: string
  targetsUsed: number
  targetCap: number
}

/**
 * Assert that the acting account's plan allows another target in this
 * workspace. The cap comes from the ACTING ACCOUNT's plan (or its active
 * trial); the count is the workspace's existing targets. A positive cap is a
 * hard limit. Enterprise uses 0 for its contract-defined limit and must not
 * be blocked by the self-serve caps.
 */
export async function assertTargetAllowed(
  workspaceId: string,
  actingAccountId: string
): Promise<TargetAllowedResult> {
  const [workspace, billing, trial] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    resolveAccountBilling(actingAccountId),
    getAccountTrialState(actingAccountId),
  ])

  if (!workspace) {
    return {
      allowed: false,
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found",
      targetsUsed: 0,
      targetCap: 0,
    }
  }

  const plan = billing?.effectivePlan ?? "FREE"
  const isTrial = trial.isActive
  const cloudPlan = CLOUD_PLAN_MAP[plan as keyof typeof CLOUD_PLAN_MAP]
  const targetCap = isTrial ? 3 : (cloudPlan?.targetCaps ?? 5)

  const targetCount = await prisma.target.count({
    where: { workspaceId, deletedAt: null },
  })

  // Hard cap for every plan. Workspaces already over their cap (e.g. after a
  // downgrade) keep all existing targets readable and scannable — only new
  // additions are blocked, and no target is ever silently deleted.
  if (targetCap > 0 && targetCount >= targetCap) {
    const message = isTrial
      ? `Your trial allows up to ${targetCap} targets. Upgrade for more.`
      : `Your plan allows up to ${targetCap} protected targets. Remove a target or upgrade to add more.`
    return {
      allowed: false,
      code: "TARGET_LIMIT_REACHED",
      message,
      targetsUsed: targetCount,
      targetCap,
    }
  }

  return {
    allowed: true,
    targetsUsed: targetCount,
    targetCap,
  }
}

/**
 * Get the grace state for an account (used by the worker mid-scan).
 */
export async function getGraceState(accountId: string) {
  return getGraceStateFromGrace(accountId)
}
