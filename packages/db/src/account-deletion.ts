import { prisma } from "./client"
import { computeAuditHash } from "./audit-hash"
import type { AuditLog } from "./generated/prisma"

const DELETED_USER = "deleted-user"

export class AccountDeletionBlockedError extends Error {
  constructor(public workspaces: Array<{ id: string; name: string }>) {
    super("Transfer ownership before deleting this account")
    this.name = "AccountDeletionBlockedError"
  }
}

export async function deleteUserAccount(userId: string): Promise<{ workspaceIds: string[] }> {
  const ownerMemberships = await prisma.workspaceMember.findMany({
    where: { userId, role: "OWNER", status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
  })
  const workspaceIds = ownerMemberships.map((membership) => membership.workspaceId)

  if (workspaceIds.length > 0) {
    const otherOwners = await prisma.workspaceMember.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        userId: { not: userId },
        role: "OWNER",
        status: "active",
      },
      select: { workspaceId: true },
    })
    const transferable = new Set(otherOwners.map((owner) => owner.workspaceId))
    const blocked = ownerMemberships
      .filter((membership) => !transferable.has(membership.workspaceId))
      .map((membership) => ({ id: membership.workspaceId, name: membership.workspace.name }))
    if (blocked.length > 0) throw new AccountDeletionBlockedError(blocked)
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

    for (const workspaceId of [...affectedWorkspaceIds].sort()) {
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
    await tx.user.delete({ where: { id: userId } })
  })

  for (const workspaceId of affectedWorkspaceIds) {
    await prisma.auditLog.create({
      data: {
        workspaceId,
        action: "account.deleted",
        resourceType: "user",
        metadata: { attribution: "anonymized" },
      },
    })
  }

  return { workspaceIds: affectedWorkspaceIds }
}
