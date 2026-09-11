/**
 * Allowance-cycle replenishment job (launch-review remediation F1 / WP-B).
 *
 * Annual subscriptions receive a monthly minute pool per allowance cycle —
 * monthly anniversaries of the term anchor — but providers emit no monthly
 * webhook inside an annual term. This job is the durable mechanism: it scans
 * every subscription row that is still entitled (active, or canceled/past_due
 * before its paid term end), computes the current allowance cycle, and
 * issues the grant idempotently.
 *
 * Exactly-once is enforced by the UsageRecord idempotency key
 * `{accountId}:{cycleStartIso}:{plan}` (plus the legacy-key probe), so
 * replays, overlapping scheduler ticks, and a rolled-back older image cannot
 * double-grant.
 *
 * Sweep is deliberately account-ordered and bounded per account via the
 * pool advisory lock — the same lock the webhook path takes.
 */

import { getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  grantMonthlyPool,
  resolveAllowanceCycle,
  CLOUD_PLAN_MAP,
  type CloudPlanId,
} from "@lyrashield/billing"

export interface ReplenishAllowanceResult {
  /** Accounts evaluated. */
  evaluated: number
  /** New grants issued this run. */
  granted: number
  /** Rows skipped (no resolvable cycle/owner/workspace attribution). */
  skipped: number
}

/** Return the first candidate that is a live (non-deleted) workspace. */
async function liveWorkspaceId(candidates: (string | null)[]): Promise<string | null> {
  const ids = candidates.filter((id): id is string => Boolean(id))
  if (ids.length === 0) return null
  const found = await getSystemPrisma().workspace.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true },
  })
  const live = new Set(found.map((w) => w.id))
  return ids.find((id) => live.has(id)) ?? null
}

/** Any workspace the account still actively belongs to (grant attribution). */
async function liveMemberWorkspace(accountId: string): Promise<string | null> {
  const membership = await getSystemPrisma().workspaceMember.findFirst({
    where: { userId: accountId, status: "active", workspace: { deletedAt: null } },
    select: { workspaceId: true },
    orderBy: { createdAt: "asc" },
  })
  return membership?.workspaceId ?? null
}

/**
 * Grant the current allowance cycle's pool for every entitled account.
 * Safe to run on any cadence; grants are idempotent per (account, cycle, plan).
 */
export async function replenishAllowanceCycles(): Promise<ReplenishAllowanceResult> {
  const now = new Date()
  // Cross-account sweep: the privileged system client only — this job's reads
  // span every account's billing rows, which the workspace/account RLS
  // context deliberately denies to ordinary paths.
  const rows = await getSystemPrisma().billingAccount.findMany({
    where: {
      deletedAt: null,
      currentPeriodStart: { not: null },
      OR: [
        { status: { in: ["active", "trialing"] } },
        {
          status: { in: ["canceled", "past_due"] },
          currentPeriodEnd: { gt: now },
        },
      ],
    },
    select: {
      id: true,
      accountId: true,
      workspaceId: true,
      purchaseWorkspaceId: true,
      status: true,
      currentPlan: true,
      interval: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
  })

  let evaluated = 0
  let granted = 0
  let skipped = 0

  for (const row of rows) {
    evaluated += 1
    const plan = row.currentPlan as CloudPlanId
    if (!row.accountId || !CLOUD_PLAN_MAP[plan] || CLOUD_PLAN_MAP[plan].agentMinutes <= 0) {
      skipped += 1
      continue
    }
    // The ledger row needs an attribution workspace for the UsageRecord FK
    // and workspace-policy visibility: the row's own attribution first, then
    // the purchase workspace, then any workspace the account still belongs
    // to (both prior candidates may point at a deleted workspace).
    const grantWorkspaceId =
      (await liveWorkspaceId([row.workspaceId, row.purchaseWorkspaceId])) ??
      (await liveMemberWorkspace(row.accountId))

    const cycle = resolveAllowanceCycle({
      interval: row.interval,
      periodStart: row.currentPeriodStart!,
      periodEnd: row.currentPeriodEnd,
      at: now,
    })
    // Past the paid term → nothing left to grant.
    if (now < row.currentPeriodStart! || (row.currentPeriodEnd && now >= row.currentPeriodEnd)) {
      skipped += 1
      continue
    }

    try {
      const outcome = await grantMonthlyPool({
        accountId: row.accountId,
        billingAccountId: row.id,
        workspaceId: grantWorkspaceId,
        plan,
        cycleStart: cycle.cycleStart,
        source: row.interval === "annual" ? "annual_monthly" : "replenishment",
      })
      if (outcome.created) {
        granted += 1
        logger.info("Replenished allowance cycle", {
          accountId: row.accountId,
          billingAccountId: row.id,
          plan,
          cycleStart: cycle.cycleStart.toISOString(),
          minutes: outcome.minutes,
        })
      }
    } catch (error) {
      // One bad row must not abort the sweep — the next tick retries it.
      skipped += 1
      logger.error("Allowance replenishment failed for account", {
        accountId: row.accountId,
        billingAccountId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (granted > 0) {
    logger.info("Allowance replenishment completed", { evaluated, granted, skipped })
  }
  return { evaluated, granted, skipped }
}
