import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scan: { findFirst: vi.fn() },
    aiSecurityScoreSnapshot: { findUnique: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
  },
}))

vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => {
    const { prisma } = await import("./client")
    return fn(prisma)
  }),
}))

import { prisma } from "./client"
import {
  createAiSecurityScoreSnapshot,
  getAiSecurityScoreSnapshot,
} from "./ai-security-score-service"
import type { AISecurityCoverage, AISecuritySignal } from "@lyrashield/security/ai-security"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>
}

describe("ai-security-score-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(mockPrisma)
    )
  })

  it("creates a private, non-shareable score snapshot with RLS", async () => {
    const scanId = "scan-1"
    const workspaceId = "ws-1"
    const targetId = "target-1"

    mockPrisma.scan.findFirst.mockResolvedValue({ id: scanId, targetId, status: "VERIFYING" })
    mockPrisma.aiSecurityScoreSnapshot.findFirst.mockResolvedValueOnce(null)
    mockPrisma.aiSecurityScoreSnapshot.create.mockResolvedValue({ id: "snapshot-1" })

    const coverage: AISecurityCoverage = {
      version: "ai-app-security/2026-08-13.1",
      totalControls: 8,
      assessedCount: 8,
      notAssessedCount: 0,
      detectedCount: 0,
      noFindingCount: 8,
      inconclusiveCount: 0,
      controls: Object.fromEntries(
        ["AI-01", "AI-02", "AI-03", "AI-04", "AI-05", "AI-06", "AI-07", "AI-08"].map((id) => [
          id,
          {
            controlId: id as AISecuritySignal["controlId"],
            state: "NO_FINDING" as const,
            assessed: true,
            evidenceSource: "deterministic" as const,
            ruleIds: ["rule-1"],
            fileCount: 1,
            signalCount: 1,
          },
        ])
      ) as AISecurityCoverage["controls"],
      limitsReached: [],
      unsupportedFiles: [],
      truncatedFiles: [],
    }

    const result = await createAiSecurityScoreSnapshot(scanId, workspaceId, {
      signals: [],
      coverage,
      ai03: { resolutionStatus: "COMPLETE", advisoryStatus: "COMPLETE", fresh: true },
    })

    expect(result.created).toBe(true)
    expect(result.snapshot.id).toBe("snapshot-1")
    expect(mockPrisma.aiSecurityScoreSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId,
          targetId,
          scanId,
          shareEligible: false,
          score: 100,
        }),
      })
    )
  })

  it("returns the existing snapshot if one already exists", async () => {
    mockPrisma.aiSecurityScoreSnapshot.findFirst.mockResolvedValue({ id: "snapshot-2" })

    const result = await getAiSecurityScoreSnapshot("scan-1", "ws-1")

    expect(result).toEqual({ id: "snapshot-2" })
    expect(mockPrisma.aiSecurityScoreSnapshot.findFirst).toHaveBeenCalledWith({
      where: { scanId: "scan-1", workspaceId: "ws-1" },
    })
  })

  it("freezes a stable input checksum and detector version with the private snapshot", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1", targetId: "target-1" })
    mockPrisma.aiSecurityScoreSnapshot.findFirst.mockResolvedValueOnce(null)
    mockPrisma.aiSecurityScoreSnapshot.create.mockResolvedValue({ id: "snapshot-3" })

    const coverage = {
      version: "ai-app-security/2026-08-13.1",
      totalControls: 0,
      assessedCount: 0,
      notAssessedCount: 0,
      detectedCount: 0,
      noFindingCount: 0,
      inconclusiveCount: 0,
      controls: {},
      limitsReached: [],
      unsupportedFiles: [],
      truncatedFiles: [],
    } as AISecurityCoverage
    const input = {
      coverage,
      detectorVersion: "detector/test",
      ai03: {
        resolutionStatus: "UNSUPPORTED" as const,
        advisoryStatus: "UNAVAILABLE" as const,
        fresh: false,
      },
    }

    await createAiSecurityScoreSnapshot("scan-1", "ws-1", input)
    const first = mockPrisma.aiSecurityScoreSnapshot.create.mock.calls[0]?.[0].data.breakdown
    vi.clearAllMocks()
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-2", targetId: "target-1" })
    mockPrisma.aiSecurityScoreSnapshot.findFirst.mockResolvedValueOnce(null)
    mockPrisma.aiSecurityScoreSnapshot.create.mockResolvedValue({ id: "snapshot-4" })
    await createAiSecurityScoreSnapshot("scan-2", "ws-1", input)
    const second = mockPrisma.aiSecurityScoreSnapshot.create.mock.calls[0]?.[0].data.breakdown

    expect(first).toMatchObject({
      detectorVersion: "detector/test",
      inputChecksum: expect.any(String),
    })
    expect(second).toMatchObject({ inputChecksum: first.inputChecksum })
  })

  it("rejects a scan outside the workspace before creating a snapshot", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    await expect(
      createAiSecurityScoreSnapshot("scan-other", "ws-1", {
        signals: [],
        coverage: {
          version: "ai-app-security/2026-08-13.1",
          totalControls: 0,
          assessedCount: 0,
          notAssessedCount: 0,
          detectedCount: 0,
          noFindingCount: 0,
          inconclusiveCount: 0,
          controls: {},
          limitsReached: [],
          unsupportedFiles: [],
          truncatedFiles: [],
        },
        ai03: { resolutionStatus: "UNSUPPORTED", advisoryStatus: "UNAVAILABLE", fresh: false },
      })
    ).rejects.toThrow("Scan or target not found")

    expect(mockPrisma.aiSecurityScoreSnapshot.create).not.toHaveBeenCalled()
  })
})
