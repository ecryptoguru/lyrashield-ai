/**
 * Backfill for Deep Review v16 item 1.4 (ruling 5): clear User.trialStartedAt
 * for users who never actually started a trial.
 *
 * History: hasUsedTrial's membership fallback ("any active membership in a
 * workspace with trialStartedAt") only ever produced false DENIALS — it never
 * wrote a user claim, and startTrial's transaction rolls back its claim write
 * whenever the eligibility check fails. So in the expected case this script
 * finds zero wrongly-marked users. It exists to PROVE that before the founder
 * clears anything, and to clear rows if any exist from an unexpected writer.
 *
 * Invariant used: every legitimate claim was written by startTrial in the
 * SAME transaction that created a trial_grant UsageRecord (100 minutes) in
 * the workspace whose trial the user started. A user whose claim is set but
 * who has no trial_grant record in ANY workspace they have ever been a member
 * of cannot have started a real trial.
 *
 * Usage:
 *   node packages/db/scripts/backfill-clear-wrong-trial-claims.ts --dry-run   (default: report only)
 *   node packages/db/scripts/backfill-clear-wrong-trial-claims.ts --apply     (clears rows, logs each id)
 *
 * The script never touches Workspace.trialStartedAt or UsageRecord rows.
 * Dry-run prints the count and the user ids it WOULD clear.
 */

import { createBoundedPgAdapter } from "../src/pool"

type BackfillPrisma = {
  user: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; email: string; trialStartedAt: Date | null }>
    >
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
  workspaceMember: {
    findMany: (args: unknown) => Promise<Array<{ userId: string; workspaceId: string }>>
  }
  usageRecord: {
    findMany: (args: unknown) => Promise<Array<{ workspaceId: string }>>
  }
}

async function findWronglyMarkedUsers(prisma: BackfillPrisma) {
  // Claimed users with no trial_grant usage record in any workspace they are
  // or were a member of. Membership rows are not soft-deleted on removal in
  // this schema, so former members are covered too. (The User model has no
  // membership back-relation — query WorkspaceMember directly.)
  const claimedUsers = await prisma.user.findMany({
    where: { trialStartedAt: { not: null } },
    select: { id: true, email: true, trialStartedAt: true },
  })
  if (claimedUsers.length === 0) return []

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: { in: claimedUsers.map((u) => u.id) } },
    select: { userId: true, workspaceId: true },
  })
  const workspacesByUser = new Map<string, string[]>()
  for (const membership of memberships) {
    const list = workspacesByUser.get(membership.userId) ?? []
    list.push(membership.workspaceId)
    workspacesByUser.set(membership.userId, list)
  }

  const grants = await prisma.usageRecord.findMany({
    where: { kind: "trial_grant", deletedAt: null },
    select: { workspaceId: true },
  })
  const workspacesWithGrant = new Set(grants.map((g) => g.workspaceId))

  return claimedUsers.filter((user) => {
    const memberOfWorkspaces = workspacesByUser.get(user.id) ?? []
    return !memberOfWorkspaces.some((workspaceId) => workspacesWithGrant.has(workspaceId))
  })
}

async function run(prisma: BackfillPrisma, apply: boolean): Promise<void> {
  const dryRun = !apply

  const users = await findWronglyMarkedUsers(prisma)

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          wronglyMarkedCount: users.length,
          wouldClear: users.map((u) => ({ id: u.id, trialStartedAt: u.trialStartedAt })),
        },
        null,
        2
      )
    )
    console.log("Run with --apply to clear these claims.")
    return
  }

  const result = await prisma.user.updateMany({
    where: { id: { in: users.map((u) => u.id) } },
    data: { trialStartedAt: null },
  })
  console.log(JSON.stringify({ mode: "apply", cleared: result.count }, null, 2))
}

async function main() {
  const databaseSystemUrl = process.env.DATABASE_SYSTEM_URL
  if (!databaseSystemUrl) {
    console.error("DATABASE_SYSTEM_URL must be set (system-level maintenance connection).")
    process.exit(1)
  }
  const { PrismaClient } = await import("../src/generated/prisma")
  const prisma = new PrismaClient({
    adapter: createBoundedPgAdapter(databaseSystemUrl),
    log: ["error"],
  })
  try {
    await run(prisma as unknown as BackfillPrisma, process.argv.includes("--apply"))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
