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
const richUserId = `rich-user-${suffix}`

const deletableWorkspaceId = `deletable-ws-${suffix}`
const retainWorkspaceId = `retain-ws-${suffix}`
const blockedWorkspaceId = `blocked-ws-${suffix}`
const soloWorkspaceId = `solo-ws-${suffix}`
const richWorkspaceId = `rich-ws-${suffix}`

const deletableWorkspaceName = `Deletable ${suffix}`
const retainWorkspaceName = `Retention ${suffix}`
const blockedWorkspaceName = `Blocked ${suffix}`
const soloWorkspaceName = `Solo ${suffix}`
const richWorkspaceName = `Rich ${suffix}`

const referralCode = `234567${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)
const rewardedReferralCode = `765432${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)

async function cleanup() {
  for (const workspaceId of [
    deletableWorkspaceId,
    retainWorkspaceId,
    blockedWorkspaceId,
    soloWorkspaceId,
    richWorkspaceId,
  ]) {
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`.catch(
      () => {}
    )
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`.catch(() => {})
  }
  await prisma.user.deleteMany({
    where: {
      id: { in: [userId, otherOwnerId, otherMemberId, soloUserId, rewardedUserId, richUserId] },
    },
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
        { id: richUserId, name: "Rich", email: `${richUserId}@example.com` },
      ],
    })
    await prisma.workspace.createMany({
      data: [
        { id: deletableWorkspaceId, name: deletableWorkspaceName, slug: deletableWorkspaceId },
        { id: retainWorkspaceId, name: retainWorkspaceName, slug: retainWorkspaceId },
        { id: blockedWorkspaceId, name: blockedWorkspaceName, slug: blockedWorkspaceId },
        { id: soloWorkspaceId, name: soloWorkspaceName, slug: soloWorkspaceId },
        { id: richWorkspaceId, name: richWorkspaceName, slug: richWorkspaceId },
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
        { workspaceId: richWorkspaceId, userId: richUserId, role: "OWNER", status: "active" },
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

  /**
   * Diagnostic case. Reproduced live in production on 2026-08-03: a real
   * account (sole owner, sole member, single workspace) with real usage —
   * one target, two completed scans, their events and coverage receipts, a
   * notification, and the audit-log trail those actions generated in the SAME
   * workspace being destroyed — failed `DELETE /api/account` with a generic
   * 500 after the confirmation check passed. The "solo" case above only
   * covers an otherwise-empty workspace and never exercises any of this.
   *
   * If this test throws, the failure message IS the answer we don't have from
   * production logs — read it before touching account-deletion.ts again.
   */
  it("deletes a sole-owner workspace with real usage: target, scans, events, coverage, audit trail", async () => {
    const target = await prisma.target.create({
      data: {
        workspaceId: richWorkspaceId,
        type: "WEB_APP",
        name: "Rich Target",
        url: "https://example.com",
      },
    })
    const scans = await Promise.all(
      [0, 1].map(() =>
        prisma.scan.create({
          data: {
            workspaceId: richWorkspaceId,
            targetId: target.id,
            goal: "LAUNCH_REVIEW",
            status: "COMPLETED",
            createdById: richUserId,
          },
        })
      )
    )
    for (const scan of scans) {
      await prisma.scanEvent.createMany({
        data: [
          { scanId: scan.id, stage: "preflight", level: "info", message: "Preflight completed" },
          { scanId: scan.id, stage: "completed", level: "info", message: "Scan status: COMPLETED" },
        ],
      })
      await prisma.scanCoverageReceipt.createMany({
        data: [
          { scanId: scan.id, scanner: "url", controlId: "url-scan", status: "BLOCKED" },
          {
            scanId: scan.id,
            scanner: "url",
            controlId: "missing-headers",
            status: "NOT_APPLICABLE",
          },
        ],
      })
    }
    await prisma.notification.create({
      data: {
        workspaceId: richWorkspaceId,
        userId: richUserId,
        type: "scan.completed",
        title: "Scan completed",
        body: "Your scan finished.",
      },
    })
    // The audit trail the app itself would have written while the user worked:
    // workspace creation, target creation, two scan-completed events — all
    // attributed to richUserId, all IN richWorkspaceId, which is about to be
    // physically deleted rather than retained. Uses the real create path (the
    // extension's own advisory-locked hash-chain logic) so this matches
    // production byte-for-byte rather than a raw insert.
    await prisma.auditLog.create({
      data: {
        workspaceId: richWorkspaceId,
        actorUserId: richUserId,
        action: "workspace.created",
        resourceType: "workspace",
      },
    })
    await prisma.auditLog.create({
      data: {
        workspaceId: richWorkspaceId,
        actorUserId: richUserId,
        action: "target.created",
        resourceType: "target",
        resourceId: target.id,
      },
    })
    for (const scan of scans) {
      await prisma.auditLog.create({
        data: {
          workspaceId: richWorkspaceId,
          actorUserId: richUserId,
          action: "scan.completed",
          resourceType: "scan",
          resourceId: scan.id,
        },
      })
    }

    await deleteUserAccount(richUserId, richWorkspaceName)

    expect(await prisma.user.findUnique({ where: { id: richUserId } })).toBeNull()
    expect(await prisma.workspace.findUnique({ where: { id: richWorkspaceId } })).toBeNull()
    expect(await prisma.target.findUnique({ where: { id: target.id } })).toBeNull()
    expect(await prisma.scan.count({ where: { workspaceId: richWorkspaceId } })).toBe(0)
    const scanIds = scans.map((scan) => scan.id)
    const remainingEvents = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM "ScanEvent" WHERE "scanId" = ANY(${scanIds})`
    expect(remainingEvents).toMatchObject([{ count: 0n }])
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
