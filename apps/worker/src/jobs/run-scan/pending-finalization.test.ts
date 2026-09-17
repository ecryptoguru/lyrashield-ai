import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prisma: {
    scan: { findUnique: vi.fn() },
  },
  completeScanWithScore: vi.fn(),
  qualifyReferralForWorkspace: vi.fn(),
  updateScanStatus: vi.fn(),
  completeRetestsForScan: vi.fn(),
  refreshGate: vi.fn(),
  reportInterruptedSettlement: vi.fn(),
  storedTerminalOutcome: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  completeScanWithScore: mocks.completeScanWithScore,
  prisma: mocks.prisma,
  qualifyReferralForWorkspace: mocks.qualifyReferralForWorkspace,
  updateScanStatus: mocks.updateScanStatus,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("../../engine/result-integrity", () => ({
  completeRetestsForScan: mocks.completeRetestsForScan,
}))
vi.mock("./lifecycle-utils", () => ({
  refreshGateVerdictAfterTerminalScan: mocks.refreshGate,
  reportInterruptedSettlement: mocks.reportInterruptedSettlement,
  storedTerminalOutcome: mocks.storedTerminalOutcome,
}))

import { resumePendingScanFinalization } from "./pending-finalization"

const params = { scanId: "scan-1", workspaceId: "ws-1", targetId: "target-1" }

function scanRow(over: Record<string, unknown> = {}) {
  return {
    status: "RUNNING",
    summary: null,
    errorCategory: null,
    errorMessage: null,
    actualCostCents: null,
    resultManifest: null,
    events: [],
    ...over,
  }
}

describe("resumePendingScanFinalization", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.prisma.scan.findUnique.mockResolvedValue(null)
    mocks.storedTerminalOutcome.mockReturnValue(null)
    mocks.completeRetestsForScan.mockResolvedValue(undefined)
    mocks.completeScanWithScore.mockResolvedValue(undefined)
    mocks.qualifyReferralForWorkspace.mockResolvedValue(undefined)
    mocks.refreshGate.mockResolvedValue(undefined)
    mocks.reportInterruptedSettlement.mockResolvedValue(undefined)
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
  })

  it("returns the stored failure for an already-FAILED scan", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({ status: "FAILED", errorCategory: "ENGINE_STOPPED", errorMessage: "boom" })
    )

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "failed",
      errorCategory: "ENGINE_STOPPED",
      errorMessage: "boom",
    })
    expect(mocks.reportInterruptedSettlement).not.toHaveBeenCalled()
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })

  it("reports interrupted settlement and completes an already-COMPLETED scan", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({ status: "COMPLETED", summary: "done" })
    )

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "completed",
      summary: "done",
    })
    expect(mocks.reportInterruptedSettlement).toHaveBeenCalledWith("ws-1", "scan-1")
  })

  it("reports interrupted settlement and fails a PARTIAL scan", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({ status: "PARTIAL", errorCategory: "CONTENT_FILTER_STOPPED" })
    )

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "failed",
      errorCategory: "CONTENT_FILTER_STOPPED",
      errorMessage: "Partial findings preserved",
    })
    expect(mocks.reportInterruptedSettlement).toHaveBeenCalledWith("ws-1", "scan-1")
  })

  it("resumes a non-COMPLETED manifest outcome without replaying billable work", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({
        status: "RUNNING",
        actualCostCents: 42,
        resultManifest: { id: "m-1", manifest: { terminalOutcome: {} } },
      })
    )
    mocks.storedTerminalOutcome.mockReturnValue({
      status: "FAILED",
      errorCategory: "ENGINE_INCOMPLETE",
      errorMessage: "no receipt",
    })

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "failed",
      errorCategory: "ENGINE_INCOMPLETE",
      errorMessage: "no receipt",
    })
    expect(mocks.completeRetestsForScan).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "ws-1",
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "ENGINE_INCOMPLETE",
      errorMessage: "no receipt",
      actualCostCents: 42,
    })
  })

  it("seals a VERIFYING scan with a manifest at STOPPED_BUDGET on budget exhaustion", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({
        status: "VERIFYING",
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: "cap reached",
        actualCostCents: 17,
        resultManifest: { id: "m-1", manifest: { terminalOutcome: {} } },
      })
    )
    // terminalOutcome is null here — the budget branch sits behind the
    // non-COMPLETED outcome guard.
    mocks.storedTerminalOutcome.mockReturnValue(null)

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "failed",
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "STOPPED_BUDGET",
      expect.objectContaining({ errorCategory: "BUDGET_EXCEEDED", actualCostCents: 17 })
    )
  })

  it("resumes retests and scoring for a VERIFYING scan with a stored manifest", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({
        status: "VERIFYING",
        summary: "findings stored",
        resultManifest: { id: "m-1", manifest: { terminalOutcome: {} } },
      })
    )
    mocks.storedTerminalOutcome.mockReturnValue({
      status: "COMPLETED",
      errorCategory: null,
      errorMessage: null,
    })

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "completed",
      summary: "findings stored",
    })
    expect(mocks.completeRetestsForScan).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "ws-1",
    })
    expect(mocks.completeScanWithScore).toHaveBeenCalledWith("scan-1", "ws-1", "findings stored")
    expect(mocks.refreshGate).toHaveBeenCalledWith("ws-1", "target-1", "scan-1")
    expect(mocks.qualifyReferralForWorkspace).toHaveBeenCalledWith("ws-1")
  })

  it("still completes when referral qualification fails", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({
        status: "VERIFYING",
        resultManifest: { id: "m-1", manifest: {} },
      })
    )
    mocks.storedTerminalOutcome.mockReturnValue({
      status: "COMPLETED",
      errorCategory: null,
      errorMessage: null,
    })
    mocks.qualifyReferralForWorkspace.mockRejectedValue(new Error("referral store down"))

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "completed",
      summary: "Scan completed",
    })
  })

  it("fails an interrupted billable phase instead of replaying it", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(
      scanRow({ status: "RUNNING", events: [{ id: "evt-1" }] })
    )

    await expect(resumePendingScanFinalization(params)).resolves.toEqual({
      status: "failed",
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
      errorMessage: expect.stringContaining("not replayed"),
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "BILLABLE_PHASE_INTERRUPTED" })
    )
    expect(mocks.completeScanWithScore).not.toHaveBeenCalled()
  })

  it("returns null when there is nothing to resume", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(scanRow({ status: "RUNNING" }))

    await expect(resumePendingScanFinalization(params)).resolves.toBeNull()
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })

  it("returns null when the scan row is gone", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue(null)
    await expect(resumePendingScanFinalization(params)).resolves.toBeNull()
  })
})
