import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "./client"
import { verifyAuditChain } from "./audit-hash"
import {
  deleteUserAccount,
  getAccountDeletionPlan,
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
} from "./account-deletion"

const suffix = randomUUID().replace(/-/g, "")
const userId = `delete-user-${suffix}`
const otherOwnerId = `other-owner-${suffix}`
const otherMemberId = `other-member-${suffix}`
const soloUserId = `solo-user-${suffix}`
const rewardedUserId = `delete-rewarded-${suffix}`

const deletableWorkspaceId = `deletable-ws-${suffix}`
const retainWorkspaceId = `retain-ws-${suffix}`
const blockedWorkspaceId = `blocked-ws-${suffix}`
const soloWorkspaceId = `solo-ws-${suffix}`

const deletableWorkspaceName = `Deletable ${suffix}`
const retainWorkspaceName = `Retention ${suffix}`
const blockedWorkspaceName = `Blocked ${suffix}`
const soloWorkspaceName = `Solo ${suffix}`

const referralCode = `234567${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)
const rewardedReferralCode = `765432${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)

async function cleanup() {
  for (const workspaceId of [
    deletableWorkspaceId,
    retainWorkspaceId,
    blockedWorkspaceId,
    soloWorkspaceId,
  ]) {
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`.catch(
      () => {}
    )
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`.catch(() => {})
  }
  await prisma.user.deleteMany({
    where: { id: { in: [userId, otherOwnerId, otherMemberId, soloUserId, rewardedUserId] } },
  })
  await prisma.referralCode.deleteMany({
    where: { code: { in: [referralCode, rewardedReferralCode] } },
  })
}

describe("account deletion", () => {
  it("exports the privacy lifecycle service", async () => {
    const exports = (await import("./index")) as Record<string, unknown>
    expect(exports.deleteUserAccount).toBeTypeOf("function")
    expect(exports.getAccountDeletionPlan).toBeTypeOf("function")
  })

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, name: "Delete", email: `${userId}@example.com` },
        { id: otherOwnerId, name: "Keep", email: `${otherOwnerId}@example.com` },
        { id: otherMemberId, name: "Member", email: `${otherMemberId}@example.com` },
        { id: soloUserId, name: "Solo", email: `${soloUserId}@example.com` },
        { id: rewardedUserId, name: "Rewarded", email: `${rewardedUserId}@example.com` },
      ],
    })
    await prisma.workspace.createMany({
      data: [
        { id: deletableWorkspaceId, name: deletableWorkspaceName, slug: deletableWorkspaceId },
        { id: retainWorkspaceId, name: retainWorkspaceName, slug: retainWorkspaceId },
        { id: blockedWorkspaceId, name: blockedWorkspaceName, slug: blockedWorkspaceId },
        { id: soloWorkspaceId, name: soloWorkspaceName, slug: soloWorkspaceId },
      ],
    })
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: deletableWorkspaceId, userId, role: "OWNER", status: "active" },
        { workspaceId: retainWorkspaceId, userId, role: "OWNER", status: "active" },
        { workspaceId: retainWorkspaceId, userId: otherOwnerId, role: "OWNER", status: "active" },
        { workspaceId: blockedWorkspaceId, userId, role: "OWNER", status: "active" },
        {
          workspaceId: blockedWorkspaceId,
          userId: otherMemberId,
          role: "MEMBER",
          status: "active",
        },
        { workspaceId: soloWorkspaceId, userId: soloUserId, role: "OWNER", status: "active" },
      ],
    })
  })

  afterAll(cleanup)

  it("previews workspaces as deletable, retained or blocked", async () => {
    const plan = await getAccountDeletionPlan(userId)
    expect(plan.deletable).toEqual([{ id: deletableWorkspaceId, name: deletableWorkspaceName }])
    expect(plan.retained).toEqual([{ id: retainWorkspaceId, name: retainWorkspaceName }])
    expect(plan.blocked).toHaveLength(1)
    expect(plan.blocked[0]?.id).toBe(blockedWorkspaceId)
    expect(plan.blocked[0]?.members).toEqual([
      { id: otherMemberId, name: "Member", email: `${otherMemberId}@example.com` },
    ])
  })

  it("blocks sole owners until another member is promoted", async () => {
    await expect(deleteUserAccount(userId, "DELETE")).rejects.toBeInstanceOf(
      AccountDeletionBlockedError
    )
  })

  it("rejects an incorrect confirmation for a deletable workspace", async () => {
    await expect(deleteUserAccount(soloUserId, "wrong")).rejects.toBeInstanceOf(
      AccountDeletionConfirmationRequiredError
    )
  })

  it("deletes a sole-owner/sole-member workspace and the account", async () => {
    const code = await prisma.referralCode.create({
      data: { userId: soloUserId, code: referralCode },
    })
    await prisma.referralAttribution.create({
      data: { codeId: code.id, referredUserId: soloUserId, source: "test" },
    })

    await deleteUserAccount(soloUserId, soloWorkspaceName)

    expect(await prisma.user.findUnique({ where: { id: soloUserId } })).toBeNull()
    expect(await prisma.workspace.findUnique({ where: { id: soloWorkspaceId } })).toBeNull()
    expect(await prisma.workspaceMember.count({ where: { workspaceId: soloWorkspaceId } })).toBe(0)
    expect(await prisma.referralCode.findUnique({ where: { code: referralCode } })).toMatchObject({
      userId: `deleted-user:${code.id}`,
    })
  })

  it("anonymizes attribution in a co-owned workspace and keeps the audit chain", async () => {
    await prisma.project.create({
      data: { workspaceId: retainWorkspaceId, name: "Owned project", ownerUserId: otherOwnerId },
    })
    await prisma.project.create({
      data: { workspaceId: retainWorkspaceId, name: "Anonymized project", ownerUserId: userId },
    })
    const target = await prisma.target.create({
      data: {
        workspaceId: retainWorkspaceId,
        type: "REPO",
        name: "Deletion target",
        repoFullName: `repo-${suffix}`,
      },
    })
    const scan = await prisma.scan.create({
      data: {
        workspaceId: retainWorkspaceId,
        targetId: target.id,
        goal: "CHECK_PR",
        createdById: otherOwnerId,
      },
    })
    const snapshot = await prisma.scoreSnapshot.create({
      data: {
        workspaceId: retainWorkspaceId,
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
    await prisma.scorecardShare.create({
      data: {
        snapshotId: snapshot.id,
        slug: `share-${suffix}`,
        publicPayload: {},
        createdById: otherOwnerId,
      },
    })
    await prisma.auditLog.create({
      data: {
        workspaceId: retainWorkspaceId,
        actorUserId: otherOwnerId,
        action: "privacy.test",
        resourceType: "user",
      },
    })

    const rewardedCode = await prisma.referralCode.create({
      data: { userId: rewardedUserId, code: rewardedReferralCode },
    })
    const rewardedAttribution = await prisma.referralAttribution.create({
      data: {
        codeId: rewardedCode.id,
        referredUserId: otherOwnerId,
        source: "test",
        status: "REWARDED",
      },
    })

    await deleteUserAccount(otherOwnerId, "DELETE")

    expect(await prisma.user.findUnique({ where: { id: otherOwnerId } })).toBeNull()
    expect(await prisma.workspace.findUnique({ where: { id: retainWorkspaceId } })).toMatchObject({
      name: retainWorkspaceName,
    })
    expect(await prisma.workspaceMember.count({ where: { userId: otherOwnerId } })).toBe(0)
    expect(
      await prisma.referralAttribution.findUnique({ where: { id: rewardedAttribution.id } })
    ).toMatchObject({
      referredUserId: `deleted-user:${rewardedAttribution.id}`,
      status: "REWARDED",
    })
    expect(
      await prisma.project.findFirst({
        where: { workspaceId: retainWorkspaceId, name: "Owned project" },
      })
    ).toMatchObject({
      ownerUserId: null,
    })
    expect(
      await prisma.project.findFirst({
        where: { workspaceId: retainWorkspaceId, name: "Anonymized project" },
      })
    ).toMatchObject({
      ownerUserId: userId,
    })
    expect(
      await prisma.scan.findFirst({ where: { workspaceId: retainWorkspaceId, id: scan.id } })
    ).toMatchObject({
      createdById: "deleted-user",
    })
    expect(
      await prisma.scorecardShare.findUnique({ where: { slug: `share-${suffix}` } })
    ).toMatchObject({
      createdById: "deleted-user",
    })
    const entries = await prisma.auditLog.findMany({
      where: { workspaceId: retainWorkspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries.some((entry) => entry.action === "account.deleted")).toBe(true)
    expect(verifyAuditChain(entries)).toBe(true)
  })
})
