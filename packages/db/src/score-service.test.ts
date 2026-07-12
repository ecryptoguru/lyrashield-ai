import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    scan: { findUnique: vi.fn(), update: vi.fn() },
    scoreSnapshot: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    scanEvent: { create: vi.fn() },
    finding: { findMany: vi.fn(), count: vi.fn() },
    project: { update: vi.fn() },
    referralCode: { findUnique: vi.fn(), create: vi.fn() },
    referralAttribution: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    scorecardShare: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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
        snapshot: { targetId: "target-1", computedAt: new Date("2026-07-01") },
      })
      mockPrisma.scoreSnapshot.findFirst.mockResolvedValue({ id: "newer" })
      mockPrisma.scorecardShare.update.mockResolvedValue({})
      const result = await getPublicScorecard("slug")
      expect(result).toMatchObject({ referralCode: "CODE2345", superseded: true })
    })

    it("returns null for unknown, revoked, or expired shares", async () => {
      mockPrisma.scorecardShare.findFirst.mockResolvedValue(null)
      expect(await getPublicScorecard("nope")).toBeNull()
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
          aggregate: vi.fn(),
        },
        finding: { findMany: vi.fn() },
        project: { update: vi.fn() },
      }
      mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
      const outcome = await completeScanWithScore("scan-1", "summary")
      expect(outcome.created).toBe(false)
      expect(tx.scoreSnapshot.create).not.toHaveBeenCalled()
      expect(tx.scan.update).not.toHaveBeenCalled()
      expect(mockPrisma.scanEvent.create).not.toHaveBeenCalled()
    })
  })
})
