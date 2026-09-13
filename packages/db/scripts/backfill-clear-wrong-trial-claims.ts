/**
 * Clear wrongly stamped `User.trialStartedAt` claims left by the retired
 * fallback that stamped the column for invited members who never received a
 * trial grant (v16 ruling; referenced by commit 6eca5f07).
 *
 * A real claim writes three things atomically in `startTrial`: the user stamp,
 * one `BillingAccount` marker row (`provider = "trial"`, `accountId = user.id`)
 * and one `UsageRecord` grant (`kind = "trial_grant"`, `accountId = user.id`).
 * A user with the stamp but NEITHER marker nor grant never received a trial —
 * the stamp is cleared so a genuine first claim is not denied.
 *
 * Candidates are selected conservatively: any trial marker or grant row for
 * the account — even a soft-deleted one — means the claim was real and the
 * user is left untouched. The report prints ids and created dates only, never
 * emails.
 *
 * Usage:
 *   DATABASE_SYSTEM_URL=… tsx packages/db/scripts/backfill-clear-wrong-trial-claims.ts            # dry-run report
 *   DATABASE_SYSTEM_URL=… tsx packages/db/scripts/backfill-clear-wrong-trial-claims.ts --apply=backfill-clear-wrong-trial-claims
 */

import { createId } from "@paralleldrive/cuid2"
import { pathToFileURL } from "node:url"

export const BACKFILL_CONFIRMATION = "backfill-clear-wrong-trial-claims"

const TRIAL_PROVIDER = "trial"
const TRIAL_GRANT_KIND = "trial_grant"

export interface TrialClaimBackfillReport {
  /** Users stamped without a real trial grant. Ids and created dates only. */
  candidates: Array<{ id: string; createdAt: string }>
  /** Users whose stamp was (or would be) cleared. */
  cleared: number
  /** Users cleared without an audit row because they own no workspace. */
  unaudited: string[]
  applied: boolean
}

export type DbTx = {
  user: {
    findMany(args: unknown): Promise<Array<{ id: string; createdAt: Date }>>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  billingAccount: {
    findFirst(args: unknown): Promise<{ id: string } | null>
  }
  usageRecord: {
    findFirst(args: unknown): Promise<{ id: string } | null>
  }
  workspaceMember: {
    findFirst(args: unknown): Promise<{ workspaceId: string } | null>
  }
  auditLog: {
    findFirst(args: unknown): Promise<{ hash: string | null; createdAt: Date } | null>
  }
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

export async function runTrialClaimBackfill(
  tx: DbTx,
  apply: boolean,
  computeAuditHash: (
    entry: {
      id: string
      workspaceId: string
      actorUserId: string | null
      action: string
      resourceType: string
      resourceId: string | null
      ipAddress: string | null
      userAgent: string | null
      metadata: unknown
      createdAt: Date
    },
    prevHash: string | null
  ) => string
): Promise<TrialClaimBackfillReport> {
  const stamped = await tx.user.findMany({
    where: { trialStartedAt: { not: null } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })

  const report: TrialClaimBackfillReport = {
    candidates: [],
    cleared: 0,
    unaudited: [],
    applied: apply,
  }

  for (const user of stamped) {
    const [marker, grant] = await Promise.all([
      tx.billingAccount.findFirst({
        where: { accountId: user.id, provider: TRIAL_PROVIDER },
        select: { id: true },
      }),
      tx.usageRecord.findFirst({
        where: { accountId: user.id, kind: TRIAL_GRANT_KIND },
        select: { id: true },
      }),
    ])
    if (marker || grant) continue
    report.candidates.push({ id: user.id, createdAt: user.createdAt.toISOString() })
  }

  if (!apply) return report

  for (const candidate of report.candidates) {
    const cleared = await tx.user.updateMany({
      where: { id: candidate.id, trialStartedAt: { not: null } },
      data: { trialStartedAt: null },
    })
    if (cleared.count !== 1) continue
    report.cleared += 1

    // Audit in the user's oldest owned workspace so the receipt lands on the
    // chain the account owner can read. Users who own none are still cleared;
    // their ids are reported instead.
    const membership = await tx.workspaceMember.findFirst({
      where: { userId: candidate.id, role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true },
    })
    if (!membership) {
      report.unaudited.push(candidate.id)
      continue
    }

    const workspaceId = membership.workspaceId
    // Serialize with concurrent audit creation for this workspace; the locked
    // chain order must match (createdAt, id) sorting exactly.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
    const last = await tx.auditLog.findFirst({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true, createdAt: true },
    })
    const prevHash = last?.hash ?? null
    const requestedCreatedAt = new Date()
    const createdAt =
      last && requestedCreatedAt <= last.createdAt
        ? new Date(last.createdAt.getTime() + 1)
        : requestedCreatedAt
    const auditId = createId()
    const metadata = { clearedTrialClaim: true }
    const hash = computeAuditHash(
      {
        id: auditId,
        workspaceId,
        actorUserId: null,
        action: "trial.claim_cleared",
        resourceType: "user",
        resourceId: candidate.id,
        ipAddress: null,
        userAgent: null,
        metadata,
        createdAt,
      },
      prevHash
    )
    await tx.$executeRaw`
      INSERT INTO "AuditLog" (
        id, "workspaceId", "actorUserId", action, "resourceType", "resourceId",
        "ipAddress", "userAgent", metadata, "prevHash", hash, "createdAt"
      ) VALUES (
        ${auditId}, ${workspaceId}, NULL, 'trial.claim_cleared', 'user', ${candidate.id},
        NULL, NULL, ${JSON.stringify(metadata)}::jsonb, ${prevHash}, ${hash}, ${createdAt}
      )`
  }

  return report
}

async function main() {
  // `--apply` writes; the pinned `--apply=<slug>` spelling makes the intent
  // explicit in runbooks and shell history.
  const apply = process.argv.some(
    (arg) => arg === "--apply" || arg === `--apply=${BACKFILL_CONFIRMATION}`
  )
  const databaseSystemUrl = process.env.DATABASE_SYSTEM_URL
  if (!databaseSystemUrl) {
    throw new Error("DATABASE_SYSTEM_URL is required; ordinary runtime credentials are refused")
  }

  const [{ PrismaClient }, { createBoundedPgAdapter }, { computeAuditHash }] = await Promise.all([
    import("../src/generated/prisma"),
    import("../src/pool"),
    import("../src/audit-hash"),
  ])
  const prisma = new PrismaClient({
    adapter: createBoundedPgAdapter(databaseSystemUrl),
    log: ["error"],
  })
  try {
    const report = await prisma.$transaction(
      async (tx) => runTrialClaimBackfill(tx as unknown as DbTx, apply, computeAuditHash),
      { isolationLevel: "Serializable", maxWait: 15_000, timeout: 120_000 }
    )
    console.log(JSON.stringify(report, null, 2))
    if (!apply) {
      console.log(
        `Dry run complete. Re-run with --apply=${BACKFILL_CONFIRMATION} to clear the stamps.`
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
