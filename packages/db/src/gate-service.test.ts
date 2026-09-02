import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    gateVerdict: { findFirst: vi.fn(), create: vi.fn() },
    target: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
    pullRequest: { findFirst: vi.fn(), update: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    fixProposal: { findFirst: vi.fn(), update: vi.fn() },
    retest: { create: vi.fn() },
  },
}))

vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma)
  ),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/gate", () => ({
  computeGateVerdict: vi.fn(() => ({
    standardVersion: "lyrashield-gate/1.0.0",
    state: "NOT_READY",
    nonCoverage: [],
    coverageStatement: [],
    blockingReasons: [],
    evidenceSummary: {
      detected: 0,
      validated: 0,
      verified: 0,
      inconclusive: 0,
      blockingUnverified: 0,
      retestConfirmed: 0,
    },
    staleness: { current: true, reason: null },
  })),
  computeInputChecksum: vi.fn(() => "input-checksum"),
  computeVerdictChecksum: vi.fn(() => "verdict-checksum"),
  requiredScannersForTarget: vi.fn(() => []),
  isTargetTypeCovered: vi.fn(() => true),
}))

vi.mock("./scan-service", () => ({
  createScan: vi.fn(async () => ({ id: "new-retest-scan-id" })),
}))

import { prisma } from "./client"
import { handleFixPrMergedAndReevaluate } from "./gate-service"

const mockPrisma = prisma as unknown as {
  pullRequest: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  scan: { findFirst: ReturnType<typeof vi.fn> }
  workspaceMember: { findFirst: ReturnType<typeof vi.fn> }
  fixProposal: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  retest: { create: ReturnType<typeof vi.fn> }
  gateVerdict: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  target: { findFirst: ReturnType<typeof vi.fn> }
  finding: { findMany: ReturnType<typeof vi.fn> }
  scanCoverageReceipt: { findMany: ReturnType<typeof vi.fn> }
}

describe("handleFixPrMergedAndReevaluate (WP3 loop-closure anchoring)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default happy-path shape: an open fix PR whose finding has a source scan
    // and a latest completed scan on the target.
    mockPrisma.pullRequest.findFirst.mockResolvedValue({
      fixProposal: {
        finding: {
          id: "finding-1",
          targetId: "target-1",
          scan: {
            id: "original-scan",
            goal: "Review the checkout flow",
            mode: "STANDARD",
            policyId: null,
            targetId: "target-1",
          },
        },
      },
    })
    mockPrisma.scan.findFirst
      // First call: latest COMPLETED scan for the target (the retest template).
      .mockResolvedValueOnce({
        id: "latest-completed",
        goal: "Review the checkout flow",
        mode: "STANDARD",
        policyId: "policy-1",
        targetId: "target-1",
      })
      // Subsequent calls inside evaluateGateForTarget.
      .mockResolvedValue(null)
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ userId: "owner-user" })
    mockPrisma.fixProposal.update.mockResolvedValue({})
    mockPrisma.retest.create.mockResolvedValue({ id: "retest-1" })
    mockPrisma.gateVerdict.create.mockResolvedValue({ id: "verdict-1" })
    mockPrisma.gateVerdict.findFirst.mockResolvedValue(null)
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1", type: "REPO" })
    mockPrisma.finding.findMany.mockResolvedValue([])
    mockPrisma.scanCoverageReceipt.findMany.mockResolvedValue([])
  })

  it("binds the Retest to a NEW retest scan, never the finding's original terminal scan", async () => {
    const outcome = await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)

    // The retest scan was created with triggerType retest from the template.
    expect(outcome).not.toBeNull()
    expect(outcome!.retestScanId).toBe("new-retest-scan-id")
    expect(mockPrisma.retest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          findingId: "finding-1",
          // THE invariant: the Retest row points at the NEW scan so that
          // completeRetestsForScan (which matches Retest.scanId === the scan
          // being completed) can actually complete it.
          scanId: "new-retest-scan-id",
          status: "pending",
        }),
      })
    )
  })

  it("returns the enqueue template fields the webhook route needs", async () => {
    const outcome = await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)

    expect(outcome!.targetId).toBe("target-1")
    expect(outcome!.goal).toBe("Review the checkout flow")
    expect(outcome!.mode).toBe("STANDARD")
    expect(outcome!.policyId).toBe("policy-1")
  })

  it("is a no-op for a branch with no open fix PR", async () => {
    mockPrisma.pullRequest.findFirst.mockResolvedValue(null)
    const outcome = await handleFixPrMergedAndReevaluate("workspace-1", "feature/unrelated-branch")
    expect(outcome).toBeNull()
    expect(mockPrisma.retest.create).not.toHaveBeenCalled()
  })

  it("falls back to the finding's source scan when the target has no completed scan", async () => {
    mockPrisma.scan.findFirst.mockReset()
    // First call (template resolution): no completed scan → fallback template.
    mockPrisma.scan.findFirst.mockResolvedValueOnce(null).mockResolvedValue(null) // evaluateGateForTarget lookups

    const outcome = await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123")
    expect(outcome).not.toBeNull()
    // The template fell back to the finding's original scan goal.
    expect(outcome!.goal).toBe("Review the checkout flow")
  })
})
