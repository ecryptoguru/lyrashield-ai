import { prisma } from "./client"
import { computeAuditHash } from "./audit-hash"

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
    await Promise.all([
      tx.project.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } }),
      tx.credentialSet.updateMany({
        where: { createdById: userId },
        data: { createdById: DELETED_USER },
      }),
      tx.scan.updateMany({ where: { createdById: userId }, data: { createdById: DELETED_USER } }),
      tx.apiKey.updateMany({ where: { createdById: userId }, data: { createdById: DELETED_USER } }),
      tx.finding.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } }),
      tx.auditLog.updateMany({ where: { actorUserId: userId }, data: { actorUserId: null } }),
      tx.report.updateMany({ where: { createdById: userId }, data: { createdById: DELETED_USER } }),
      tx.notification.updateMany({ where: { userId }, data: { userId: null } }),
      tx.schedule.updateMany({
        where: { createdById: userId },
        data: { createdById: DELETED_USER },
      }),
      tx.invitation.updateMany({
        where: { invitedById: userId },
        data: { invitedById: DELETED_USER },
      }),
      tx.agentApproval.updateMany({
        where: { requestedById: userId },
        data: { requestedById: DELETED_USER },
      }),
      tx.agentApproval.updateMany({
        where: { approvedById: userId },
        data: { approvedById: null },
      }),
      tx.workspaceMember.updateMany({
        where: { invitedById: userId },
        data: { invitedById: null },
      }),
      tx.onboardingState.deleteMany({ where: { userId } }),
      tx.workspaceMember.deleteMany({ where: { userId } }),
    ])

    for (const workspaceId of [...affectedWorkspaceIds].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
      const entries = await tx.auditLog.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
      let prevHash: string | null = null
      for (const entry of entries) {
        const hash = computeAuditHash(entry, prevHash)
        await tx.auditLog.update({ where: { id: entry.id }, data: { prevHash, hash } })
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
