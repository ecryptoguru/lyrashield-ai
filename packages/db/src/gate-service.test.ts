import { describe, it, expect, vi, beforeEach } from "vitest"

const rlsTransactionNestingGuard = vi.hoisted(() => ({ enabled: false, depth: 0 }))

vi.mock("./client", () => ({
  prisma: {
    $executeRaw: vi.fn(),
    findingCandidate: { findMany: vi.fn().mockResolvedValue([]) },
    gateVerdict: { findFirst: vi.fn(), create: vi.fn() },
    target: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
    pullRequest: { findFirst: vi.fn(), update: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    fixProposal: { findFirst: vi.fn(), update: vi.fn() },
    retest: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
  },
}))

vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => {
    if (rlsTransactionNestingGuard.enabled && rlsTransactionNestingGuard.depth > 0) {
      throw new Error("nested withWorkspaceRLS transaction")
    }
    rlsTransactionNestingGuard.depth++
    try {
      return await fn(prisma)
    } finally {
      rlsTransactionNestingGuard.depth--
    }
  }),
  bindAccountRLSContext: vi.fn(async () => {}),
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
  updateScanStatus: vi.fn(),
  WorkspaceScanConcurrencyLimitError: class extends Error {},
}))

import { prisma } from "./client"
import { computeGateVerdict } from "@lyrashield/gate"
import { createScan, WorkspaceScanConcurrencyLimitError } from "./scan-service"
import {
  evaluateGateForTarget,
  handleFixPrMergedAndReevaluate as handleMerge,
} from "./gate-service"
const admission = vi.fn(async () => {})
const workerAvailable = vi.fn(async () => {
  if (rlsTransactionNestingGuard.depth > 0) {
    throw new Error("Redis worker admission check ran inside a database transaction")
  }
})
const resolveRetestSource = vi.fn(async () => {
  if (rlsTransactionNestingGuard.depth > 0)
    throw new Error("Source resolution ran inside a database transaction")
  return { revision: "a".repeat(40) }
})
const handleFixPrMergedAndReevaluate = (workspaceId: string, branch: string, prNumber?: number) =>
  handleMerge({
    workspaceId,
    branchName: branch,
    prNumber,
    assertRetestAllowed: admission,
    repoFullName: undefined,
    assertRetestWorkerAvailable: workerAvailable,
    resolveRetestSource,
  })

const mockPrisma = prisma as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>
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
    rlsTransactionNestingGuard.enabled = false
    rlsTransactionNestingGuard.depth = 0
    admission.mockResolvedValue(undefined)
    workerAvailable.mockImplementation(async () => {
      if (rlsTransactionNestingGuard.depth > 0) {
        throw new Error("Redis worker admission check ran inside a database transaction")
      }
    })
    vi.mocked(prisma.retest.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.findingCandidate.findMany).mockResolvedValue([])
    vi.mocked(createScan).mockResolvedValue({ id: "new-retest-scan-id" } as never)
    // Default happy-path shape: an open fix PR whose finding has a source scan
    // and a latest completed scan on the target.
    mockPrisma.pullRequest.findFirst.mockResolvedValue({
      id: "pr-1",
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

  it("does not open nested workspace transactions while handling a merge", async () => {
    rlsTransactionNestingGuard.enabled = true
    try {
      await expect(
        handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
      ).resolves.not.toBeNull()
      const advisoryKeys = mockPrisma.$executeRaw.mock.calls
        .filter((call) => String(call[0]).includes("pg_advisory_xact_lock"))
        .map((call) => call[1])
      expect(advisoryKeys).toEqual([
        "fix-loop:workspace-1:lyrashield/fix-abc123",
        "scan-user:owner-user",
        "fix-loop:workspace-1:lyrashield/fix-abc123",
      ])
    } finally {
      rlsTransactionNestingGuard.enabled = false
      rlsTransactionNestingGuard.depth = 0
    }
  })

  it("pins the current target source before write locks and preserves it in the retest plan", async () => {
    await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    expect(resolveRetestSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "target-1", type: "REPO" })
    )
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({ source: { revision: "a".repeat(40) } }),
      expect.anything()
    )
    expect(resolveRetestSource.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.pullRequest.update.mock.invocationCallOrder[0]!
    )
  })

  it("does not create a retest when source resolution fails", async () => {
    resolveRetestSource.mockRejectedValueOnce(new Error("SCAN_REF_UNRESOLVED"))
    await expect(
      handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).rejects.toThrow("SCAN_REF_UNRESOLVED")
    expect(createScan).not.toHaveBeenCalled()
    expect(mockPrisma.pullRequest.update).not.toHaveBeenCalled()
  })

  it("rejects target changes between source observation and the locked scan plan", async () => {
    mockPrisma.target.findFirst.mockResolvedValueOnce({
      id: "target-1",
      type: "REPO",
      branch: "old-branch",
    })
    await expect(
      handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).rejects.toThrow("SCAN_REF_UNRESOLVED")
    expect(createScan).not.toHaveBeenCalled()
  })

  it("checks Redis worker availability before opening the retest lock transaction", async () => {
    await expect(
      handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).resolves.not.toBeNull()

    expect(workerAvailable).toHaveBeenCalledOnce()
  })

  it("keeps legacy retest claims uncertain without complete bound evidence", async () => {
    mockPrisma.scan.findFirst.mockReset().mockResolvedValue(null)
    const receipts = [
      { status: "DETECTED", method: "RETEST", scanId: "retest-scan" },
      { status: "INCONCLUSIVE", method: "RETEST", scanId: "retest-scan" },
      {
        status: "VALIDATED",
        method: "RETEST",
        scanId: "retest-scan",
        verifierVersion: "result-integrity-1",
        evidence: { baseline: { scanId: "source-scan" }, retest: { scanId: "retest-scan" } },
      },
    ]
    mockPrisma.finding.findMany.mockImplementation(async ({ select }) => [
      {
        id: "finding-1",
        severity: "HIGH",
        status: "FIXED",
        verificationStatus: "VALIDATED",
        lastSeenAt: new Date(),
        scanId: "source-scan",
        dedupeKey: "finding-key",
        disposition: null,
        dispositionActorUserId: null,
        dispositionReason: null,
        dispositionAssessmentId: null,
        dispositionAt: null,
        canonicalFindingId: null,
        verificationReceipts: receipts
          .filter(
            (receipt) =>
              receipt.method === "RETEST" ||
              select.verificationReceipts.where.OR[0].status.in.includes(receipt.status)
          )
          .reverse(),
      },
    ])

    await evaluateGateForTarget("workspace-1", "target-1")

    expect(mockPrisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1", targetId: "target-1", deletedAt: null },
        select: expect.objectContaining({
          verificationReceipts: expect.objectContaining({
            where: { OR: [{ status: { in: ["VALIDATED", "VERIFIED"] } }, { method: "RETEST" }] },
          }),
        }),
      })
    )
    expect(vi.mocked(computeGateVerdict).mock.lastCall?.[0].findings[0]).toMatchObject({
      hasPositiveEvidence: false,
      retestConfirmedResolved: false,
    })

    receipts.pop()
    await evaluateGateForTarget("workspace-1", "target-1")
    expect(vi.mocked(computeGateVerdict).mock.lastCall?.[0].findings[0]).toMatchObject({
      hasPositiveEvidence: false,
      retestConfirmedResolved: false,
    })
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
  it("narrows deterministic Deep findings before checking entitlement", async () => {
    const anchor = await mockPrisma.pullRequest.findFirst()
    anchor.fixProposal.finding.scan.mode = "DEEP"
    mockPrisma.pullRequest.findFirst.mockResolvedValue(anchor)
    vi.mocked(prisma.findingCandidate.findMany).mockResolvedValue([
      { scannerSource: "secrets" },
    ] as never)
    const outcome = await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    expect(admission).toHaveBeenCalledWith("SAFE", "owner-user", expect.anything())
    expect(outcome?.mode).toBe("SAFE")
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "SAFE", determinismMode: "targeted_scanner" }),
      prisma
    )
  })
  it("creates no scan when admission fails or a retest is pending", async () => {
    admission.mockRejectedValueOnce(new Error("RETEST_NOT_ENTITLED"))
    await expect(
      handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).rejects.toThrow("RETEST_NOT_ENTITLED")
    expect(createScan).not.toHaveBeenCalled()
    vi.mocked(prisma.retest.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "pending" } as never)
    expect(
      await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).toBeNull()
    expect(createScan).not.toHaveBeenCalled()
  })
  it("defers concurrency failures for redelivery without creating a retest", async () => {
    vi.mocked(createScan).mockRejectedValueOnce(new WorkspaceScanConcurrencyLimitError())
    await expect(
      handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    ).rejects.toBeInstanceOf(WorkspaceScanConcurrencyLimitError)
    expect(prisma.retest.create).not.toHaveBeenCalled()
  })
  it("reuses the durable queued scan on delivery retry", async () => {
    vi.mocked(prisma.retest.findFirst).mockResolvedValue({
      id: "retest-existing",
      scanId: "queued-1",
      scan: { status: "QUEUED", mode: "SAFE", goal: "Review", policyId: null },
    } as never)
    const result = await handleFixPrMergedAndReevaluate("workspace-1", "lyrashield/fix-abc123", 42)
    expect(result?.retestScanId).toBe("queued-1")
    expect(createScan).not.toHaveBeenCalled()
    expect(resolveRetestSource).not.toHaveBeenCalled()
    expect(prisma.$executeRaw).toHaveBeenCalled()
  })
  it("fails closed without the injected admission boundary", async () => {
    await expect(
      handleMerge({
        workspaceId: "workspace-1",
        branchName: "branch",
        prNumber: undefined,
        assertRetestAllowed: undefined as never,
        repoFullName: undefined,
        assertRetestWorkerAvailable: workerAvailable,
        resolveRetestSource,
      })
    ).rejects.toThrow("Retest admission guard required")
  })
})
