import { prisma } from "./client"
import { computeAuditHash } from "./audit-hash"
import type { AuditLog } from "./generated/prisma"

const DELETED_USER = "deleted-user"

export interface AccountDeletionWorkspace {
  id: string
  name: string
}

export interface AccountDeletionBlockedWorkspace extends AccountDeletionWorkspace {
  members: Array<{ id: string; name: string | null; email: string }>
}

export interface AccountDeletionPlan {
  /** Workspaces that will be physically deleted along with the account. */
  deletable: AccountDeletionWorkspace[]
  /** Workspaces the user owns alone but that have other active members. */
  blocked: AccountDeletionBlockedWorkspace[]
  /** Workspaces that survive with anonymized attribution. */
  retained: AccountDeletionWorkspace[]
}

export class AccountDeletionBlockedError extends Error {
  constructor(
    public workspaces: AccountDeletionBlockedWorkspace[],
    public expectedConfirmation: string | null = null
  ) {
    super("Transfer ownership before deleting this account")
    this.name = "AccountDeletionBlockedError"
  }
}

export class AccountDeletionConfirmationRequiredError extends Error {
  constructor(
    public deletableWorkspaces: AccountDeletionWorkspace[],
    public expectedConfirmation: string
  ) {
    super("Confirmation required before deleting this account")
    this.name = "AccountDeletionConfirmationRequiredError"
  }
}

/**
 * Preview the workspaces that will be deleted, blocked, or retained when an
 * account is removed. This is intentionally side-effect free and may be called
 * from UI server paths to decide which confirmation to ask for.
 */
export async function getAccountDeletionPlan(userId: string): Promise<AccountDeletionPlan> {
  const ownerMemberships = await prisma.workspaceMember.findMany({
    where: { userId, role: "OWNER", status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
  })
  const ownedWorkspaceIds = ownerMemberships.map((membership) => membership.workspaceId)

  let allActiveMembers: Array<{ workspaceId: string; userId: string; role: string }> = []
  if (ownedWorkspaceIds.length > 0) {
    allActiveMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId: { in: ownedWorkspaceIds }, status: "active" },
      select: { workspaceId: true, userId: true, role: true },
    })
  }

  const otherMemberUserIds = [
    ...new Set(
      allActiveMembers.filter((member) => member.userId !== userId).map((member) => member.userId)
    ),
  ]
  const users =
    otherMemberUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: otherMemberUserIds } },
          select: { id: true, name: true, email: true },
        })
      : []
  const userById = new Map(users.map((user) => [user.id, user]))

  const deletable: AccountDeletionWorkspace[] = []
  const blocked: AccountDeletionBlockedWorkspace[] = []

  for (const membership of ownerMemberships) {
    const workspaceId = membership.workspaceId
    const otherActiveMembers = allActiveMembers.filter(
      (member) => member.workspaceId === workspaceId && member.userId !== userId
    )
    const otherOwners = otherActiveMembers.filter((member) => member.role === "OWNER")
    const otherNonOwners = otherActiveMembers.filter((member) => member.role !== "OWNER")

    if (otherOwners.length > 0) continue

    const workspace = { id: workspaceId, name: membership.workspace.name }
    if (otherNonOwners.length === 0) {
      deletable.push(workspace)
    } else {
      blocked.push({
        ...workspace,
        members: otherNonOwners.map((member) => {
          const user = userById.get(member.userId)
          return { id: member.userId, name: user?.name ?? null, email: user?.email ?? "" }
        }),
      })
    }
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  })
  const actorWorkspaces = await prisma.auditLog.findMany({
    where: { actorUserId: userId },
    select: { workspaceId: true },
  })
  const affectedWorkspaceIds = [
    ...new Set([
      ...memberships.map((membership) => membership.workspaceId),
      ...actorWorkspaces.map((entry) => entry.workspaceId),
    ]),
  ]

  const retainedIds = affectedWorkspaceIds.filter(
    (id) =>
      !deletable.some((workspace) => workspace.id === id) &&
      !blocked.some((workspace) => workspace.id === id)
  )

  const retainedWorkspaces =
    retainedIds.length > 0
      ? await prisma.workspace.findMany({
          where: { id: { in: retainedIds } },
          select: { id: true, name: true },
        })
      : []
  const retainedById = new Map(
    retainedWorkspaces.map((workspace) => [workspace.id, workspace.name])
  )

  return {
    deletable,
    blocked,
    retained: retainedIds.map((id) => ({ id, name: retainedById.get(id) ?? id })),
  }
}

/**
 * Physically delete the user, removing sole-owner/sole-member workspaces and
 * anonymizing attribution in any workspace the user co-owned or contributed to.
 *
 * Confirmation rules:
 *  - Workspaces with another active owner are retained; no special confirmation.
 *  - Sole-owner workspaces with other active members block deletion.
 *  - Sole-owner/sole-member workspaces are physically deleted — including their
 *    audit history, deliberately purged to allow the hard delete — and require
 *    the user to type the list of workspace names being destroyed.
 *  - Otherwise the user must type "DELETE".
 */
export async function deleteUserAccount(
  userId: string,
  confirmation = "DELETE"
): Promise<{ workspaceIds: string[] }> {
  const plan = await getAccountDeletionPlan(userId)

  if (plan.blocked.length > 0) {
    throw new AccountDeletionBlockedError(plan.blocked)
  }

  const expectedConfirmation =
    plan.deletable.length > 0
      ? plan.deletable
          .map((workspace) => workspace.name)
          .sort()
          .join(", ")
      : "DELETE"

  if (confirmation !== expectedConfirmation) {
    throw new AccountDeletionConfirmationRequiredError(plan.deletable, expectedConfirmation)
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  })
  const actorWorkspaces = await prisma.auditLog.findMany({
    where: { actorUserId: userId },
    select: { workspaceId: true },
  })
  const affectedWorkspaceIds = [
    ...new Set([
      ...memberships.map((membership) => membership.workspaceId),
      ...actorWorkspaces.map((entry) => entry.workspaceId),
    ]),
  ]
  const retainedWorkspaceIds = affectedWorkspaceIds.filter(
    (id) => !plan.deletable.some((workspace) => workspace.id === id)
  )

  await prisma.$transaction(async (tx) => {
    // These models are deliberately not workspace-RLS scoped. Keep their user
    // attribution cleanup outside the per-workspace context loop below.
    await Promise.all([
      // userId is UNIQUE, so retain a non-identifying per-row suffix. A shared
      // sentinel makes the second account deletion with a referral code fail.
      tx.$executeRaw`
        UPDATE "ReferralCode"
        SET "userId" = ${`${DELETED_USER}:`} || "id"
        WHERE "userId" = ${userId}`,
      tx.scorecardShare.updateMany({
        where: { createdById: userId },
        data: { createdById: DELETED_USER },
      }),
      // Anonymize the deleted user's referral attribution. Only reject rewards
      // still in flight (PENDING/QUALIFIED); already-REWARDED/REJECTED rows keep
      // their terminal status so referral metrics and reward history stay truthful.
      // referredUserId is UNIQUE, so the anonymized value must stay unique per
      // row ("deleted-user:{rowId}") — a shared constant sentinel would make
      // every account deletion after the first fail the unique constraint.
      // The prefix can never collide with a real user id (cuids contain no ":").
      tx.$executeRaw`
        UPDATE "ReferralAttribution"
        SET "referredUserId" = ${`${DELETED_USER}:`} || "id",
            "status" = 'REJECTED'::"ReferralStatus"
        WHERE "referredUserId" = ${userId}
          AND "status" IN ('PENDING'::"ReferralStatus", 'QUALIFIED'::"ReferralStatus")`,
      tx.$executeRaw`
        UPDATE "ReferralAttribution"
        SET "referredUserId" = ${`${DELETED_USER}:`} || "id"
        WHERE "referredUserId" = ${userId}
          AND "status" IN ('REWARDED'::"ReferralStatus", 'REJECTED'::"ReferralStatus")`,
      // ScorecardEvent contains only a privacy-safe visitor hash, never a user identifier.
      tx.workspaceMember.updateMany({
        where: { invitedById: userId },
        data: { invitedById: null },
      }),
      tx.onboardingState.deleteMany({ where: { userId } }),
      tx.workspaceMember.deleteMany({ where: { userId } }),
    ])

    for (const workspaceId of [...retainedWorkspaceIds].sort()) {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`

      // Every workspace-owned mutation carries an explicit tenant predicate
      // and runs only after its matching transaction-local RLS context is set.
      await tx.project.updateMany({
        where: { workspaceId, ownerUserId: userId },
        data: { ownerUserId: null },
      })
      await tx.credentialSet.updateMany({
        where: { workspaceId, createdById: userId },
        data: { createdById: DELETED_USER },
      })
      await tx.scan.updateMany({
        where: { workspaceId, createdById: userId },
        data: { createdById: DELETED_USER },
      })
      await tx.apiKey.updateMany({
        where: { workspaceId, createdById: userId },
        data: { createdById: DELETED_USER },
      })
      await tx.finding.updateMany({
        where: { workspaceId, ownerUserId: userId },
        data: { ownerUserId: null },
      })
      await tx.report.updateMany({
        where: { workspaceId, createdById: userId },
        data: { createdById: DELETED_USER },
      })
      await tx.notification.updateMany({
        where: { workspaceId, userId },
        data: { userId: null },
      })
      await tx.schedule.updateMany({
        where: { workspaceId, createdById: userId },
        data: { createdById: DELETED_USER },
      })
      await tx.invitation.updateMany({
        where: { workspaceId, invitedById: userId },
        data: { invitedById: DELETED_USER },
      })
      await tx.agentApproval.updateMany({
        where: { workspaceId, requestedById: userId },
        data: { requestedById: DELETED_USER },
      })
      await tx.agentApproval.updateMany({
        where: { workspaceId, approvedById: userId },
        data: { approvedById: null },
      })
      // The chain rebuild must observe anonymized attribution and must remain
      // serialized with concurrent audit creation for this workspace.
      await tx.auditLog.updateMany({
        where: { workspaceId, actorUserId: userId },
        data: { actorUserId: null },
      })
      const entries = await tx.$queryRaw<AuditLog[]>`
        SELECT * FROM "AuditLog"
        WHERE "workspaceId" = ${workspaceId}
        ORDER BY "createdAt" ASC, id ASC`
      let prevHash: string | null = null
      for (const entry of entries) {
        const hash = computeAuditHash(entry, prevHash)
        await tx.$executeRaw`
          UPDATE "AuditLog"
          SET "prevHash" = ${prevHash}, "hash" = ${hash}
          WHERE id = ${entry.id} AND "workspaceId" = ${workspaceId}`
        prevHash = hash
      }
    }

    // Physically delete sole-owner/sole-member workspaces. The database cascade
    // removes their dependent rows. The Workspace model has a deletedAt column and
    // is soft-deleted by the Prisma client extension, so this must bypass the
    // extension and use raw SQL.
    //
    // A BEFORE DELETE trigger (workspace_prevent_hard_delete, added in
    // 20260707120000 as S3) refuses to hard-delete a Workspace while any
    // AuditLog row still references it, specifically to keep the hash-chained
    // audit trail immutable — it is not represented in schema.prisma, the same
    // way the RLS policies aren't, so it's easy to miss. This deletion path is
    // a user-initiated, right-to-erasure request, so audit history for THIS
    // workspace is deliberately purged first rather than preserved: erasure was
    // chosen over indefinite retention for the account+workspace a user asks to
    // delete outright. This does not weaken the trigger elsewhere — the RETAINED
    // path above keeps and anonymizes its audit chain untouched, and any other
    // hard-delete of a workspace with history is still blocked.
    for (const workspace of [...plan.deletable].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace.id}, true)`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspace.id}, 0))`
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspace.id}`
      await tx.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspace.id}`
    }

    await tx.user.delete({ where: { id: userId } })
  })

  for (const workspaceId of retainedWorkspaceIds) {
    await prisma.auditLog.create({
      data: {
        workspaceId,
        action: "account.deleted",
        resourceType: "user",
        metadata: { attribution: "anonymized" },
      },
    })
  }

  return { workspaceIds: retainedWorkspaceIds }
}
