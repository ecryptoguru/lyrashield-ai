import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "./client"
import { verifyAuditChain } from "./audit-hash"
import {
  deleteUserAccount,
  getAccountDeletionPlan,
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
  AccountDeletionActiveScanError,
  AccountDeletionUnsupportedArtifactError,
} from "./account-deletion"

const suffix = randomUUID().replace(/-/g, "")
const userId = `delete-user-${suffix}`
const otherOwnerId = `other-owner-${suffix}`
const otherMemberId = `other-member-${suffix}`
const soloUserId = `solo-user-${suffix}`
const rewardedUserId = `delete-rewarded-${suffix}`
const richUserId = `rich-user-${suffix}`
const activeUserId = `active-user-${suffix}`
const legacyUserId = `legacy-user-${suffix}`
const auditFailureUserId = `audit-failure-user-${suffix}`
const auditFailureOwnerId = `audit-failure-owner-${suffix}`

const deletableWorkspaceId = `deletable-ws-${suffix}`
const retainWorkspaceId = `retain-ws-${suffix}`
const blockedWorkspaceId = `blocked-ws-${suffix}`
const soloWorkspaceId = `solo-ws-${suffix}`
const richWorkspaceId = `rich-ws-${suffix}`
const activeWorkspaceId = `active-ws-${suffix}`
const legacyWorkspaceId = `legacy-ws-${suffix}`
const auditFailureWorkspaceId = `audit-failure-ws-${suffix}`

const deletableWorkspaceName = `Deletable ${suffix}`
const retainWorkspaceName = `Retention ${suffix}`
const blockedWorkspaceName = `Blocked ${suffix}`
const soloWorkspaceName = `Solo ${suffix}`
const richWorkspaceName = `Rich ${suffix}`
const activeWorkspaceName = `Active ${suffix}`
const legacyWorkspaceName = `Legacy ${suffix}`
const auditFailureWorkspaceName = "Account deletion audit rollback fixture"

const referralCode = `234567${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)
const rewardedReferralCode = `765432${suffix.slice(-2).padStart(2, "2")}`.slice(0, 8)

async function cleanup() {
  await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_reject_account_deleted ON "AuditLog"`.catch(
    () => {}
  )
  await prisma.$executeRaw`DROP FUNCTION IF EXISTS test_reject_account_deleted()`.catch(() => {})
  for (const workspaceId of [
    deletableWorkspaceId,
    retainWorkspaceId,
    blockedWorkspaceId,
    soloWorkspaceId,
    richWorkspaceId,
    activeWorkspaceId,
    legacyWorkspaceId,
    auditFailureWorkspaceId,
  ]) {
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`.catch(
      () => {}
    )
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`.catch(() => {})
  }
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          userId,
          otherOwnerId,
          otherMemberId,
          soloUserId,
          rewardedUserId,
          richUserId,
          activeUserId,
          legacyUserId,
          auditFailureUserId,
          auditFailureOwnerId,
        ],
      },
    },
  })
  await prisma.referralCode.deleteMany({
    where: { code: { in: [referralCode, rewardedReferralCode] } },
  })
  await prisma.artifactDeletionTask.deleteMany({
    where: { workspaceId: { in: [richWorkspaceId, activeWorkspaceId, legacyWorkspaceId] } },
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
        { id: activeUserId, name: "Active", email: `${activeUserId}@example.com` },
        { id: legacyUserId, name: "Legacy", email: `${legacyUserId}@example.com` },
        {
          id: auditFailureUserId,
          name: "Audit failure",
          email: `${auditFailureUserId}@example.com`,
        },
        {
          id: auditFailureOwnerId,
          name: "Audit failure owner",
          email: `${auditFailureOwnerId}@example.com`,
        },
      ],
    })
    await prisma.workspace.createMany({
      data: [
        { id: deletableWorkspaceId, name: deletableWorkspaceName, slug: deletableWorkspaceId },
        { id: retainWorkspaceId, name: retainWorkspaceName, slug: retainWorkspaceId },
        { id: blockedWorkspaceId, name: blockedWorkspaceName, slug: blockedWorkspaceId },
        { id: soloWorkspaceId, name: soloWorkspaceName, slug: soloWorkspaceId },
        { id: richWorkspaceId, name: richWorkspaceName, slug: richWorkspaceId },
        { id: activeWorkspaceId, name: activeWorkspaceName, slug: activeWorkspaceId },
        { id: legacyWorkspaceId, name: legacyWorkspaceName, slug: legacyWorkspaceId },
        {
          id: auditFailureWorkspaceId,
          name: auditFailureWorkspaceName,
          slug: auditFailureWorkspaceId,
        },
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
        { workspaceId: activeWorkspaceId, userId: activeUserId, role: "OWNER", status: "active" },
        { workspaceId: legacyWorkspaceId, userId: legacyUserId, role: "OWNER", status: "active" },
        {
          workspaceId: auditFailureWorkspaceId,
          userId: auditFailureUserId,
          role: "OWNER",
          status: "active",
        },
        {
          workspaceId: auditFailureWorkspaceId,
          userId: auditFailureOwnerId,
          role: "OWNER",
          status: "active",
        },
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
   * Regression test. Reproduced live in production on 2026-08-03: a real
   * account (sole owner, sole member, single workspace) with real usage —
   * one target, two completed scans, their events and coverage receipts, a
   * notification, and the audit-log trail those actions generated in the SAME
   * workspace being destroyed — failed `DELETE /api/account` with a generic
   * 500 after the confirmation check passed. The "solo" case above only
   * covers an otherwise-empty workspace and never exercised this.
   *
   * Root cause: `workspace_prevent_hard_delete` (migration 20260707120000, S3)
   * is a BEFORE DELETE trigger — not represented in schema.prisma — that
   * refuses to hard-delete a Workspace while any AuditLog row still
   * references it, to keep the audit trail immutable. `deleteUserAccount` now
   * purges that workspace's audit history first: erasure was chosen over
   * retention for a workspace the user asks to delete outright. This test
   * pins that behavior end to end.
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
    const evidenceFinding = await prisma.finding.create({
      data: {
        workspaceId: richWorkspaceId,
        targetId: target.id,
        scanId: scans[0]!.id,
        title: "Retained evidence",
        summary: "Deletion outbox regression",
        severity: "LOW",
        dedupeKey: `delete-evidence-${suffix}`,
      },
    })
    const evidenceStorageUri = `s3://evidence-test/evidence/${richWorkspaceId}/${evidenceFinding.id}/receipt.enc`
    await prisma.evidence.create({
      data: {
        findingId: evidenceFinding.id,
        type: "receipt",
        storageUri: evidenceStorageUri,
        encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
        checksum: suffix.padEnd(64, "0").slice(0, 64),
        redactionStatus: "complete",
      },
    })
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

    const deletion = await deleteUserAccount(richUserId, richWorkspaceName)

    expect(await prisma.user.findUnique({ where: { id: richUserId } })).toBeNull()
    expect(await prisma.workspace.findUnique({ where: { id: richWorkspaceId } })).toBeNull()
    expect(await prisma.target.findUnique({ where: { id: target.id } })).toBeNull()
    expect(await prisma.scan.count({ where: { workspaceId: richWorkspaceId } })).toBe(0)
    const scanIds = scans.map((scan) => scan.id)
    const remainingEvents = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM "ScanEvent" WHERE "scanId" = ANY(${scanIds})`
    expect(remainingEvents).toMatchObject([{ count: 0n }])
    // The audit trail for the erased workspace must be gone, not orphaned —
    // this is what workspace_prevent_hard_delete blocked before the purge was
    // added, and what makes this a real erasure rather than a partial one.
    const remainingAuditLogs = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM "AuditLog" WHERE "workspaceId" = ${richWorkspaceId}`
    expect(remainingAuditLogs).toMatchObject([{ count: 0n }])
    expect(deletion.artifactDeletionTaskIds).toHaveLength(1)
    expect(
      await prisma.artifactDeletionTask.findUnique({
        where: { kind_storageUri: { kind: "EVIDENCE", storageUri: evidenceStorageUri } },
      })
    ).toMatchObject({ workspaceId: richWorkspaceId, status: "PENDING" })
  })

  it("fails closed while a deletable workspace has an active scan", async () => {
    const scan = await prisma.scan.create({
      data: {
        workspaceId: activeWorkspaceId,
        goal: "LAUNCH_REVIEW",
        status: "RUNNING",
        createdById: activeUserId,
      },
    })

    await expect(deleteUserAccount(activeUserId, activeWorkspaceName)).rejects.toBeInstanceOf(
      AccountDeletionActiveScanError
    )
    expect(await prisma.workspace.findUnique({ where: { id: activeWorkspaceId } })).not.toBeNull()
    expect(await prisma.user.findUnique({ where: { id: activeUserId } })).not.toBeNull()

    await prisma.scan.update({ where: { id: scan.id }, data: { status: "CANCELLED" } })
    await deleteUserAccount(activeUserId, activeWorkspaceName)
  })

  it("fails closed for legacy report storage without a deletion contract", async () => {
    const report = await prisma.report.create({
      data: {
        workspaceId: legacyWorkspaceId,
        title: "Legacy report",
        createdById: legacyUserId,
        storageUri: "s3://legacy-reports/report.html",
      },
    })

    await expect(deleteUserAccount(legacyUserId, legacyWorkspaceName)).rejects.toBeInstanceOf(
      AccountDeletionUnsupportedArtifactError
    )
    expect(await prisma.workspace.findUnique({ where: { id: legacyWorkspaceId } })).not.toBeNull()

    await prisma.report.update({ where: { id: report.id }, data: { storageUri: null } })
    await deleteUserAccount(legacyUserId, legacyWorkspaceName)
  })

  it("rolls back account deletion when the retained-workspace audit receipt fails", async () => {
    await prisma.auditLog.create({
      data: {
        workspaceId: auditFailureWorkspaceId,
        actorUserId: auditFailureUserId,
        action: "privacy.audit-failure-fixture",
        resourceType: "user",
      },
    })
    await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_reject_account_deleted ON "AuditLog"`
    await prisma.$executeRaw`DROP FUNCTION IF EXISTS test_reject_account_deleted()`
    await prisma.$executeRaw`
      CREATE FUNCTION test_reject_account_deleted()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.action = 'account.deleted' AND EXISTS (
          SELECT 1 FROM "Workspace"
          WHERE id = NEW."workspaceId"
            AND name = 'Account deletion audit rollback fixture'
        ) THEN
          RAISE EXCEPTION 'account deletion audit fixture failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`
    await prisma.$executeRaw`
      CREATE TRIGGER test_reject_account_deleted
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION test_reject_account_deleted()`

    try {
      await expect(deleteUserAccount(auditFailureUserId, "DELETE")).rejects.toThrow(
        "account deletion audit fixture failure"
      )
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_reject_account_deleted ON "AuditLog"`
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS test_reject_account_deleted()`
    }

    expect(await prisma.user.findUnique({ where: { id: auditFailureUserId } })).not.toBeNull()
    expect(
      await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: auditFailureWorkspaceId,
            userId: auditFailureUserId,
          },
        },
      })
    ).not.toBeNull()
    const entries = await prisma.auditLog.findMany({
      where: { workspaceId: auditFailureWorkspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries.some((entry) => entry.action === "account.deleted")).toBe(false)
    expect(verifyAuditChain(entries)).toBe(true)
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
    await prisma.notificationPreference.create({
      data: { userId: otherOwnerId },
    })
    const domainVerification = await prisma.targetDomainVerification.create({
      data: {
        workspaceId: retainWorkspaceId,
        domain: `deletion-${suffix}.example.com`,
        method: "DNS_TXT",
        expiresAt: new Date(Date.now() + 86400000),
        createdById: otherOwnerId,
      },
    })
    const liveSettings = await prisma.liveAiSafetySettings.create({
      data: {
        workspaceId: retainWorkspaceId,
        incidentContact: `${otherOwnerId}@example.com`,
        createdById: otherOwnerId,
      },
    })
    const livePlan = await prisma.liveAiSafetyPlan.create({
      data: {
        workspaceId: retainWorkspaceId,
        targetId: target.id,
        domainVerificationId: domainVerification.id,
        endpointUrl: "https://deletion.example.com/safety",
        approvedHost: "deletion.example.com",
        authMode: "NONE",
        incidentContact: `${otherOwnerId}@example.com`,
        maxRequests: 1,
        maxDurationSeconds: 60,
        maxResponseBytes: 1024,
        rawSampleStorage: "none",
        cases: [],
        approvedById: otherOwnerId,
        createdById: otherOwnerId,
      },
    })
    const aiProfile = await prisma.aiSystemProfile.create({
      data: {
        workspaceId: retainWorkspaceId,
        targetId: target.id,
        profile: {},
        createdById: otherOwnerId,
        updatedById: otherOwnerId,
        versions: {
          create: {
            version: 1,
            profile: {},
            checksum: `profile-${suffix}`,
            createdById: otherOwnerId,
          },
        },
      },
      include: { versions: true },
    })
    const threatModel = await prisma.threatModel.create({
      data: {
        workspaceId: retainWorkspaceId,
        targetId: target.id,
        versions: {
          create: {
            version: 1,
            content: {},
            checksum: `threat-${suffix}`,
            createdById: otherOwnerId,
          },
        },
      },
      include: { versions: true },
    })
    const controlEvidence = await prisma.controlEvidence.create({
      data: {
        workspaceId: retainWorkspaceId,
        targetId: target.id,
        controlId: `control-${suffix}`,
        versions: {
          create: {
            version: 1,
            status: "ACCEPTED",
            attestation: "Account deletion regression fixture",
            reviewedById: otherOwnerId,
            artifactManifest: [],
            checksum: `control-${suffix}`,
            createdById: otherOwnerId,
          },
        },
      },
      include: { versions: true },
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
    expect(
      await prisma.notificationPreference.findUnique({ where: { userId: otherOwnerId } })
    ).toBeNull()
    expect(
      await prisma.targetDomainVerification.findUnique({ where: { id: domainVerification.id } })
    ).toMatchObject({ createdById: "deleted-user" })
    expect(
      await prisma.liveAiSafetySettings.findUnique({ where: { id: liveSettings.id } })
    ).toMatchObject({ createdById: "deleted-user" })
    expect(await prisma.liveAiSafetyPlan.findUnique({ where: { id: livePlan.id } })).toMatchObject({
      createdById: "deleted-user",
      approvedById: null,
    })
    expect(await prisma.aiSystemProfile.findUnique({ where: { id: aiProfile.id } })).toMatchObject({
      createdById: "deleted-user",
      updatedById: "deleted-user",
    })
    expect(
      await prisma.aiSystemProfileVersion.findUnique({ where: { id: aiProfile.versions[0]!.id } })
    ).toMatchObject({ createdById: "deleted-user" })
    expect(
      await prisma.threatModelVersion.findUnique({ where: { id: threatModel.versions[0]!.id } })
    ).toMatchObject({ createdById: "deleted-user" })
    expect(
      await prisma.controlEvidenceVersion.findUnique({
        where: { id: controlEvidence.versions[0]!.id },
      })
    ).toMatchObject({ createdById: "deleted-user", reviewedById: null })
    const entries = await prisma.auditLog.findMany({
      where: { workspaceId: retainWorkspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries.some((entry) => entry.action === "account.deleted")).toBe(true)
    expect(verifyAuditChain(entries)).toBe(true)
  })
})
