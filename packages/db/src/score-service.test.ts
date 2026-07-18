import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    scan: { findUnique: vi.fn(), update: vi.fn() },
    scoreSnapshot: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    scanEvent: { create: vi.fn() },
    finding: { findMany: vi.fn(), count: vi.fn() },
    project: { update: vi.fn() },
    target: { update: vi.fn() },
    referralCode: { findUnique: vi.fn(), create: vi.fn() },
    referralAttribution: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    scorecardShare: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    scorecardEvent: { createMany: vi.fn() },
    usageRecord: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
  },
}))

import { prisma } from "./client"
import {
  buildScorecardPayload,
  attributeReferral,
  getPublicScorecard,
  completeScanWithScore,
  recordScorecardEvent,
  createScorecardShare,
} from "./score-service"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>
}

describe("score-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("buildScorecardPayload (disclosure allowlist)", () => {
    it("emits EXACTLY the five allowlisted fields — nothing else may ever be added silently", () => {
      const payload = buildScorecardPayload(
        {
          grade: "A",
          computedAt: new Date("2026-07-12T00:00:00Z"),
          modelVersion: "lyrashield-score/1.0.0",
        },
        3
      )
      // Spec §5: this exact key set is load-bearing. If this test fails because a field
      // was added, that field is about to become PUBLIC — stop and review the disclosure
      // implications before changing the assertion.
      expect(Object.keys(payload).sort()).toEqual([
        "grade",
        "modelVersion",
        "resolvedFindings",
        "scannedAt",
        "scope",
      ])
      expect(payload).not.toHaveProperty("targetUrl")
      expect(payload).not.toHaveProperty("breakdown")
    })
  })

  describe("attributeReferral", () => {
    it("rejects self-referral", () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({ id: "rc-1", userId: "user-1" })
      return attributeReferral("CODE2345", "user-1").then((result) => {
        expect(result).toBeNull()
        expect(mockPrisma.referralAttribution.upsert).not.toHaveBeenCalled()
      })
    })

    it("rejects attribution for pre-existing accounts (no retroactive rewards)", async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({ id: "rc-1", userId: "referrer" })
      mockPrisma.user.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      })
      const result = await attributeReferral("CODE2345", "old-user")
      expect(result).toBeNull()
      expect(mockPrisma.referralAttribution.upsert).not.toHaveBeenCalled()
    })

    it("attributes a freshly created account exactly once via upsert", async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({ id: "rc-1", userId: "referrer" })
      mockPrisma.user.findUnique.mockResolvedValue({ createdAt: new Date() })
      mockPrisma.referralAttribution.upsert.mockResolvedValue({ id: "attr-1" })
      const result = await attributeReferral("CODE2345", "new-user", "iphash", "scorecard")
      expect(result).toEqual({ id: "attr-1" })
      expect(mockPrisma.referralAttribution.upsert).toHaveBeenCalledWith({
        where: { referredUserId: "new-user" },
        create: {
          codeId: "rc-1",
          referredUserId: "new-user",
          source: "scorecard",
          ipHash: "iphash",
        },
        update: {},
      })
    })
  })

  describe("getPublicScorecard", () => {
    it("returns the frozen payload with a supersession flag when a newer snapshot exists", async () => {
      mockPrisma.scorecardShare.findFirst.mockResolvedValue({
        id: "share-1",
        publicPayload: { grade: "A" },
        referralCode: { code: "CODE2345" },
        snapshot: {
          targetId: "target-1",
          workspaceId: "workspace-1",
          computedAt: new Date("2026-07-01"),
        },
      })
      mockPrisma.scoreSnapshot.findFirst.mockResolvedValue({ id: "newer" })
      const result = await getPublicScorecard("slug")
      expect(result).toMatchObject({ referralCode: "CODE2345", superseded: true })
      expect(mockPrisma.scoreSnapshot.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ targetId: "target-1", workspaceId: "workspace-1" }),
        })
      )
      expect(mockPrisma.scorecardShare.update).not.toHaveBeenCalled()
    })

    it("returns null for unknown, revoked, or expired shares", async () => {
      mockPrisma.scorecardShare.findFirst.mockResolvedValue(null)
      expect(await getPublicScorecard("nope")).toBeNull()
    })
  })

  describe("recordScorecardEvent", () => {
    it("deduplicates human views and increments the legacy counter only once", async () => {
      mockPrisma.scorecardShare.findFirst.mockResolvedValue({ id: "share-1" })
      mockPrisma.scorecardEvent.createMany.mockResolvedValue({ count: 1 })
      mockPrisma.scorecardShare.update.mockResolvedValue({})
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))

      const result = await recordScorecardEvent("slug", {
        eventType: "VIEW",
        visitorId: "visitor-1",
        source: "public",
      })

      expect(result).toEqual({ recorded: true })
      expect(mockPrisma.scorecardEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.scorecardShare.update).toHaveBeenCalledWith({
        where: { id: "share-1" },
        data: { viewCount: { increment: 1 } },
      })
    })
  })

  describe("createScorecardShare", () => {
    it("reuses one active scorecard across workspace admins", async () => {
      mockPrisma.scoreSnapshot.findFirst.mockResolvedValue({
        id: "snapshot-1",
        grade: "A",
        computedAt: new Date("2026-07-16T00:00:00Z"),
        modelVersion: "test",
      })
      mockPrisma.referralCode.findUnique.mockResolvedValue({ id: "ref-b", code: "CODEBBBB" })
      mockPrisma.finding.count.mockResolvedValue(0)
      mockPrisma.scorecardEvent.count = vi.fn().mockResolvedValue(0)
      mockPrisma.referralAttribution.count = vi.fn().mockResolvedValue(0)
      const tx = {
        $executeRaw: vi.fn(),
        scorecardShare: {
          findFirst: vi.fn().mockResolvedValue({
            id: "share-1",
            snapshotId: "snapshot-1",
            referralCodeId: "ref-a",
            referralCode: { code: "CODEAAAA" },
          }),
          create: vi.fn(),
        },
      }
      mockPrisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
        fn(tx)
      )

      const result = await createScorecardShare("target-1", "workspace-1", "admin-b")

      expect(result).toMatchObject({
        share: { id: "share-1" },
        referralCode: "CODEAAAA",
      })
      expect(tx.scorecardShare.create).not.toHaveBeenCalled()
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled()
    })
  })

  describe("completeScanWithScore", () => {
    it("is idempotent: an existing snapshot short-circuits without re-completing the scan", async () => {
      const tx = {
        scan: {
          findUnique: vi.fn().mockResolvedValue({
            id: "scan-1",
            status: "COMPLETED",
            target: { id: "t-1", projectId: null, branch: null },
          }),
          update: vi.fn(),
        },
        scoreSnapshot: {
          findUnique: vi.fn().mockResolvedValue({ id: "snap-1", score: 90, grade: "A" }),
          findFirst: vi.fn(),
          create: vi.fn(),
          findMany: vi.fn(),
        },
        finding: { findMany: vi.fn() },
        project: { update: vi.fn() },
        target: { update: vi.fn() },
        scanEvent: { create: vi.fn() },
      }
      mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
      const outcome = await completeScanWithScore("scan-1", "summary")
      expect(outcome.created).toBe(false)
      expect(tx.scoreSnapshot.create).not.toHaveBeenCalled()
      expect(tx.scan.update).not.toHaveBeenCalled()
      expect(mockPrisma.scanEvent.create).not.toHaveBeenCalled()
    })

    it("uses only each target's latest live score for project risk and records last scan time", async () => {
      const tx = {
        scan: {
          findUnique: vi.fn().mockResolvedValue({
            id: "scan-1",
            workspaceId: "ws-1",
            targetId: "t-1",
            status: "VERIFYING",
            mode: "STANDARD",
            target: { id: "t-1", projectId: "p-1", branch: "main" },
          }),
          update: vi.fn().mockResolvedValue({ id: "scan-1", status: "COMPLETED" }),
        },
        scoreSnapshot: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue({ score: 55 }),
          findMany: vi.fn().mockResolvedValue([{ score: 92 }, { score: 78 }]),
          create: vi.fn().mockResolvedValue({ id: "snap-1", score: 96, grade: "A" }),
        },
        finding: { findMany: vi.fn().mockResolvedValue([]) },
        project: { update: vi.fn().mockResolvedValue({}) },
        target: { update: vi.fn().mockResolvedValue({}) },
        scanEvent: { create: vi.fn().mockResolvedValue({}) },
      }
      mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
      mockPrisma.scanEvent.create.mockResolvedValue({})

      await completeScanWithScore("scan-1", "done")

      expect(tx.scoreSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ distinct: ["targetId"] })
      )
      expect(tx.project.update).toHaveBeenCalledWith({
        where: { id: "p-1" },
        data: { riskScore: 78 },
      })
      expect(tx.target.update).toHaveBeenCalledWith({
        where: { id: "t-1" },
        data: { lastScanAt: expect.any(Date) },
      })
    })

    it("keeps unvalidated FIXED findings in the score until a trusted receipt exists", async () => {
      const tx = {
        scan: {
          findUnique: vi.fn().mockResolvedValue({
            id: "scan-1",
            workspaceId: "ws-1",
            targetId: "t-1",
            status: "VERIFYING",
            mode: "STANDARD",
            target: { id: "t-1", projectId: null, branch: "main" },
          }),
          update: vi.fn().mockResolvedValue({ id: "scan-1", status: "COMPLETED" }),
        },
        scoreSnapshot: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn(),
          create: vi.fn().mockResolvedValue({ id: "snap-1", score: 90, grade: "B" }),
        },
        finding: {
          findMany: vi.fn().mockResolvedValue([
            {
              severity: "HIGH",
              status: "FIXED",
              verified: true,
              verificationStatus: "DETECTED",
              category: null,
            },
          ]),
        },
        project: { update: vi.fn() },
        target: { update: vi.fn().mockResolvedValue({}) },
        scanEvent: { create: vi.fn().mockResolvedValue({}) },
      }
      mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
      mockPrisma.scanEvent.create.mockResolvedValue({})

      await completeScanWithScore("scan-1", "done")

      expect(tx.scoreSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ score: 90, grade: "B" }) })
      )
    })
  })
})
