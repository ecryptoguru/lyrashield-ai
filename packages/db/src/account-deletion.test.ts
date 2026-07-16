import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { verifyAuditChain } from "./audit-hash"

const suffix = `${Date.now()}`
const userId = `delete-user-${suffix}`
const otherUserId = `keep-user-${suffix}`
const workspaceId = `delete-workspace-${suffix}`
const referralCode = `234567${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)
const rewardedReferralCode = `765432${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)

describe("account deletion", () => {
  it("exports the privacy lifecycle service", async () => {
    const exports = (await import("./index")) as Record<string, unknown>
    expect(exports.deleteUserAccount).toBeTypeOf("function")
  })

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, name: "Delete", email: `${userId}@example.com` },
        { id: otherUserId, name: "Keep", email: `${otherUserId}@example.com` },
      ],
    })
    await prisma.workspace.create({
      data: { id: workspaceId, name: "Deletion", slug: workspaceId },
    })
    await prisma.workspaceMember.create({
      data: { workspaceId, userId, role: "OWNER", status: "active" },
    })
  })

  afterAll(async () => {
    await prisma.referralCode.deleteMany({
      where: { code: { in: [referralCode, rewardedReferralCode] } },
    })
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherUserId, `delete-rewarded-${suffix}`] } },
    })
    await prisma.$disconnect()
  })

  it("blocks sole owners, then anonymizes attribution without breaking the audit chain", async () => {
    const { AccountDeletionBlockedError, deleteUserAccount } = await import("./account-deletion")
    await expect(deleteUserAccount(userId)).rejects.toBeInstanceOf(AccountDeletionBlockedError)

    await prisma.workspaceMember.create({
      data: { workspaceId, userId: otherUserId, role: "OWNER", status: "active" },
    })
    await prisma.project.create({
      data: { workspaceId, name: "Owned project", ownerUserId: userId },
    })
    const target = await prisma.target.create({
      data: { workspaceId, type: "REPO", name: "Deletion target", repoFullName: `repo-${suffix}` },
    })
    const scan = await prisma.scan.create({
      data: { workspaceId, targetId: target.id, goal: "CHECK_PR", createdById: userId },
    })
    const snapshot = await prisma.scoreSnapshot.create({
      data: {
        workspaceId,
        targetId: target.id,
        scanId: scan.id,
        modelVersion: "test",
        score: 90,
        grade: "A",
        breakdown: {},
        scanMode: "SAFE",
        expiresAt: new Date(Date.now() + 86400000),
      },
    })
    const code = await prisma.referralCode.create({ data: { userId, code: referralCode } })
    await prisma.referralAttribution.create({
      data: { codeId: code.id, referredUserId: userId, source: "test" },
    })
    // A user can only ever be referred once (referredUserId is UNIQUE), so the
    // already-rewarded case needs its own user: on deletion the attribution must
    // keep its terminal REWARDED status (only the user identifier is anonymized)
    // so reward history stays truthful.
    const rewardedUserId = `delete-rewarded-${suffix}`
    await prisma.user.create({
      data: { id: rewardedUserId, name: "Rewarded", email: `${rewardedUserId}@example.com` },
    })
    const rewardedCode = await prisma.referralCode.create({
      data: { userId: rewardedUserId, code: rewardedReferralCode },
    })
    const rewardedAttribution = await prisma.referralAttribution.create({
      data: {
        codeId: code.id,
        referredUserId: rewardedUserId,
        source: "test",
        status: "REWARDED",
      },
    })
    await prisma.scorecardShare.create({
      data: {
        snapshotId: snapshot.id,
        slug: `share-${suffix}`,
        publicPayload: {},
        createdById: userId,
      },
    })
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "privacy.test",
        resourceType: "user",
      },
    })

    await deleteUserAccount(userId)

    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
    expect(await prisma.workspaceMember.count({ where: { userId } })).toBe(0)
    expect(await prisma.referralCode.findUnique({ where: { code: referralCode } })).toMatchObject({
      userId: `deleted-user:${code.id}`,
    })
    const rejected = await prisma.referralAttribution.findFirst({
      where: { codeId: code.id, status: "REJECTED" },
    })
    // The anonymized value is per-row unique (referredUserId is UNIQUE): a
    // shared sentinel would make every deletion after the first one fail.
    expect(rejected?.referredUserId).toBe(`deleted-user:${rejected?.id}`)
    // Deleting the rewarded user's account keeps the attribution's terminal
    // REWARDED status while anonymizing the user reference.
    const { deleteUserAccount: deleteRewardedUser } = await import("./account-deletion")
    await deleteRewardedUser(rewardedUserId)
    expect(
      await prisma.referralCode.findUnique({ where: { code: rewardedReferralCode } })
    ).toMatchObject({ userId: `deleted-user:${rewardedCode.id}` })
    expect(
      await prisma.referralAttribution.findUnique({ where: { id: rewardedAttribution.id } })
    ).toMatchObject({
      referredUserId: `deleted-user:${rewardedAttribution.id}`,
      status: "REWARDED",
    })
    expect(
      await prisma.scorecardShare.findUnique({ where: { slug: `share-${suffix}` } })
    ).toMatchObject({
      createdById: "deleted-user",
    })
    expect(await prisma.project.findFirst({ where: { workspaceId } })).toMatchObject({
      ownerUserId: null,
    })
    const entries = await prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries.some((entry) => entry.action === "account.deleted")).toBe(true)
    expect(verifyAuditChain(entries)).toBe(true)
  })
})
