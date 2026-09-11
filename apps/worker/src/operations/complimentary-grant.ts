/**
 * Complimentary Launch Assurance grant — account-owned, no-charge path.
 *
 * Founder-authorized procedure for granting Launch Assurance to named
 * accounts without a provider subscription or payment. The grant is an
 * ordinary BillingAccount row keyed (provider="complimentary",
 * externalId="comp-la-<accountId>") — the account-owned architecture treats
 * it exactly like a paid subscription: the monthly pool comes from
 * `grantMonthlyPool`, cycles replenish via the scheduled job, and DEEP
 * entitlement follows the plan.
 *
 * Safety properties:
 *  - dry-run by default; mutation requires `--apply --confirm <phrase>`;
 *  - refuses to touch an account with an existing non-complimentary
 *    subscription row (a paying customer is never overwritten);
 *  - `--revoke` performs the audited reversal: the complimentary row is
 *    soft-deleted + downgraded, and its unconsumed pool grants are removed;
 *  - every mutation writes an AuditLog row in the attribution workspace.
 *
 * Usage:
 *   pnpm --filter @lyrashield/worker comp:grant --email a@b.com [--apply --confirm "GRANT COMPLIMENTARY LAUNCH ASSURANCE"]
 *   pnpm --filter @lyrashield/worker comp:grant --email a@b.com --revoke --confirm "REVOKE COMPLIMENTARY LAUNCH ASSURANCE"
 */

import { parseArgs } from "node:util"
import { getSystemPrisma, prisma, withAccountRLS } from "@lyrashield/db"
import { grantMonthlyPool, resolveAllowanceCycle } from "@lyrashield/billing"

const COMP_PROVIDER = "complimentary"
const COMP_PLAN = "LAUNCH_ASSURANCE" as const
const APPLY_PHRASE = "GRANT COMPLIMENTARY LAUNCH ASSURANCE"
const REVOKE_PHRASE = "REVOKE COMPLIMENTARY LAUNCH ASSURANCE"

function compExternalId(accountId: string): string {
  return `comp-la-${accountId}`
}

/** First live workspace the account belongs to — grant/audit attribution. */
async function attributionWorkspace(accountId: string): Promise<string | null> {
  const member = await getSystemPrisma().workspaceMember.findFirst({
    where: { userId: accountId, status: "active", workspace: { deletedAt: null } },
    select: { workspaceId: true },
    orderBy: { createdAt: "asc" },
  })
  return member?.workspaceId ?? null
}

interface AccountPlan {
  email: string
  userId: string | null
  workspaceId: string | null
  existingRows: { id: string; provider: string; status: string; currentPlan: string }[]
  action: "grant" | "revoke" | "none"
  detail: string
}

async function planFor(email: string, revoke: boolean): Promise<AccountPlan> {
  const user = await getSystemPrisma().user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true },
  })
  if (!user?.emailVerified) {
    return {
      email,
      userId: null,
      workspaceId: null,
      existingRows: [],
      action: "none",
      detail: "user not found",
    }
  }
  const rows = await getSystemPrisma().billingAccount.findMany({
    where: { accountId: user.id, deletedAt: null },
    select: { id: true, provider: true, status: true, currentPlan: true },
  })
  const comp = rows.find((r) => r.provider === COMP_PROVIDER)
  const paid = rows.find(
    (r) => r.provider !== COMP_PROVIDER && r.provider !== "trial" && r.currentPlan !== "FREE"
  )
  const workspaceId = await attributionWorkspace(user.id)

  if (revoke) {
    if (!comp)
      return {
        email,
        userId: user.id,
        workspaceId,
        existingRows: rows,
        action: "none",
        detail: "no complimentary row",
      }
    return {
      email,
      userId: user.id,
      workspaceId,
      existingRows: rows,
      action: "revoke",
      detail: `soft-delete comp row ${comp.id}, downgrade to FREE`,
    }
  }
  if (paid) {
    return {
      email,
      userId: user.id,
      workspaceId,
      existingRows: rows,
      action: "none",
      detail: `refused: existing ${paid.provider} subscription (${paid.status}/${paid.currentPlan}) — never overwrite a paying subscription`,
    }
  }
  if (comp) {
    return {
      email,
      userId: user.id,
      workspaceId,
      existingRows: rows,
      action: "grant",
      detail: "reconcile existing complimentary grant idempotently",
    }
  }
  return {
    email,
    userId: user.id,
    workspaceId,
    existingRows: rows,
    action: "grant",
    detail: `create complimentary ${COMP_PLAN} row; grant current monthly pool`,
  }
}

async function applyGrant(
  plan: AccountPlan,
  auditWorkspaceId: string,
  actorUserId: string
): Promise<void> {
  const system = getSystemPrisma()
  const now = new Date()
  const row = await system.billingAccount.upsert({
    where: {
      provider_externalId: { provider: COMP_PROVIDER, externalId: compExternalId(plan.userId!) },
    },
    create: {
      provider: COMP_PROVIDER,
      externalId: compExternalId(plan.userId!),
      accountId: plan.userId!,
      workspaceId: null,
      purchaseWorkspaceId: plan.workspaceId,
      status: "active",
      currentPlan: COMP_PLAN,
      interval: "monthly",
      currentPeriodStart: now,
      currentPeriodEnd: null,
    },
    update: {
      accountId: plan.userId!,
      status: "active",
      currentPlan: COMP_PLAN,
      deletedAt: null,
    },
  })

  const cycle = resolveAllowanceCycle({
    interval: "monthly",
    periodStart: row.currentPeriodStart!,
    periodEnd: null,
    at: now,
  })
  const grant = await grantMonthlyPool({
    accountId: plan.userId!,
    workspaceId: null,
    billingAccountId: row.id,
    plan: COMP_PLAN,
    cycleStart: cycle.cycleStart,
    source: "manual",
  })
  await prisma.auditLog.create({
    data: {
      workspaceId: auditWorkspaceId,
      actorUserId,
      action: "billing.complimentary_granted",
      resourceType: "billing_account",
      resourceId: row.id,
      metadata: {
        accountId: plan.userId,
        noCharge: true,
        poolGranted: grant.created,
        poolMinutes: grant.minutes,
      },
    },
  })
}

async function applyRevoke(
  plan: AccountPlan,
  auditWorkspaceId: string,
  actorUserId: string
): Promise<void> {
  const now = new Date()
  const comp = plan.existingRows.find((r) => r.provider === COMP_PROVIDER)!
  const removed = await withAccountRLS(plan.userId!, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pool:${plan.userId}`}, 0))`
    await tx.billingAccount.update({
      where: { id: comp.id },
      data: { status: "downgraded", currentPlan: "FREE", deletedAt: now },
    })
    return tx.usageRecord.updateMany({
      where: {
        accountId: plan.userId!,
        kind: "pool_grant",
        deletedAt: null,
        metadata: { path: ["billingAccountId"], equals: comp.id },
      },
      data: { deletedAt: now },
    })
  })
  await prisma.auditLog.create({
    data: {
      workspaceId: auditWorkspaceId,
      actorUserId,
      action: "billing.complimentary_revoked",
      resourceType: "billing_account",
      resourceId: comp.id,
      metadata: { accountId: plan.userId, poolGrantsRemoved: removed.count },
    },
  })
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "audit-workspace": { type: "string" },
      "actor-user": { type: "string" },
      email: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      revoke: { type: "boolean", default: false },
      confirm: { type: "string" },
    },
    strict: true,
  })

  const emails = values.email ?? []
  if (emails.length === 0) {
    console.error(
      "usage: comp:grant --email <email> [--email ...] [--apply|--revoke --confirm <phrase>]"
    )
    process.exitCode = 2
    return
  }

  const plans: AccountPlan[] = []
  for (const email of emails) plans.push(await planFor(email, values.revoke))

  console.log(
    `\ncomplimentary-grant ${values.revoke ? "REVOKE" : values.apply ? "APPLY" : "DRY-RUN"}`
  )
  for (const p of plans) {
    console.log(`  ${p.email}: ${p.action} — ${p.detail}`)
    for (const r of p.existingRows) {
      console.log(`    existing: ${r.provider} ${r.status} ${r.currentPlan} (${r.id})`)
    }
  }

  const mutating = values.apply || values.revoke
  const phrase = values.revoke ? REVOKE_PHRASE : APPLY_PHRASE
  if (!mutating) {
    console.log("\ndry-run only — pass --apply (or --revoke) plus --confirm to mutate")
    return
  }
  if (values.confirm !== phrase) {
    console.error(`\nrefusing to mutate without --confirm "${phrase}"`)
    process.exitCode = 2
    return
  }

  const auditWorkspaceId = values["audit-workspace"]
  const actorUserId = values["actor-user"]
  if (!auditWorkspaceId || !actorUserId) throw new Error("audit_workspace_and_actor_required")
  const actor = await getSystemPrisma().user.findUnique({
    where: { id: actorUserId },
    select: { platformRole: true, emailVerified: true },
  })
  const auditWorkspace = await getSystemPrisma().workspace.findUnique({
    where: { id: auditWorkspaceId },
    select: { deletedAt: true },
  })
  if (
    !actor?.emailVerified ||
    actor.platformRole !== "PLATFORM_OPERATOR" ||
    !auditWorkspace ||
    auditWorkspace.deletedAt
  )
    throw new Error("invalid_audit_context")
  // This administrative workspace attributes the audit, never owns the entitlement.
  for (const p of plans) {
    if (p.action === "none") continue
    await prisma.auditLog.create({
      data: {
        workspaceId: auditWorkspaceId,
        actorUserId,
        action: "billing.complimentary_intent",
        resourceType: "account",
        resourceId: p.userId,
        metadata: { action: p.action, noCharge: true },
      },
    })
    if (p.action === "grant") await applyGrant(p, auditWorkspaceId, actorUserId)
    else if (p.action === "revoke") await applyRevoke(p, auditWorkspaceId, actorUserId)
    console.log(`  ✓ ${p.email}: ${p.action} complete`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
