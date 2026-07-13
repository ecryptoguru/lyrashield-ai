import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    target: {
      findFirst: vi.fn(),
    },
    policy: {
      findFirst: vi.fn(),
    },
    scan: {
      findUnique: vi.fn(),
    },
  },
  updateScanStatus: vi.fn().mockResolvedValue({ id: "scan-1" }),
  completeScanWithScore: vi.fn().mockResolvedValue({}),
  qualifyReferralForWorkspace: vi.fn().mockResolvedValue(null),
  addScanEvent: vi.fn().mockResolvedValue(undefined),
  runWithWorkspaceContext: <T>(_wsId: string | null, fn: () => T): T => fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock("../engine/runner", () => ({
  runEngine: vi.fn().mockResolvedValue({
    exitCode: 0,
    output: {
      vulnerabilities: [],
      runRecord: { run_id: "r1", status: "completed" },
      summary: "Scan completed with 0 findings",
      findingCount: 0,
    },
  }),
  cleanupEngineWorkspace: vi.fn().mockResolvedValue(undefined),
  interpretExitCode: vi.fn((code: number) => {
    if (code === 0) return { status: "COMPLETED", category: "SUCCESS" }
    if (code === 2) return { status: "COMPLETED", category: "VULNERABILITIES_FOUND" }
    return { status: "FAILED", category: "ENGINE_ERROR", message: `Engine error (code ${code})` }
  }),
}))

vi.mock("../engine/finding-persister", () => ({
  persistFindings: vi.fn().mockResolvedValue([]),
}))

vi.mock("./preflight.job", () => ({
  runPreflight: vi.fn().mockResolvedValue({ passed: true, checks: [] }),
}))

vi.mock("../notifications", () => ({
  notifyScanCompleted: vi.fn().mockResolvedValue(undefined),
  notifyScanFailed: vi.fn().mockResolvedValue(undefined),
  notifyCriticalFinding: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../engine/scanner-orchestrator", () => ({
  runScannerOrchestrator: vi.fn().mockResolvedValue({
    allFindings: [],
    engineFindings: [],
    scaFindings: [],
    secretsFindings: [],
    stats: {
      total: 0,
      bySeverity: {},
      byConfidence: { high: 0, medium: 0, low: 0 },
      verified: 0,
      unverified: 0,
      falsePositiveRisk: { low: 0, medium: 0, high: 0 },
    },
    filteredFalsePositives: 0,
  }),
}))

import { processScanJob } from "./run-scan.job"
import { runPreflight } from "./preflight.job"
import { runEngine, cleanupEngineWorkspace, interpretExitCode } from "../engine/runner"
import { persistFindings } from "../engine/finding-persister"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import { notifyScanCompleted } from "../notifications"
import {
  completeScanWithScore,
  qualifyReferralForWorkspace,
  updateScanStatus,
  prisma,
} from "@lyrashield/db"

const mockJob = {
  id: "job-1",
  data: {
    scanId: "scan-1",
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "SAFE",
  },
} as never

const mockTarget = {
  id: "target-1",
  name: "Test Target",
  type: "WEB_APP",
  url: "https://example.com",
  repoFullName: null,
  deletedAt: null,
}

describe("processScanJob", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default mock implementations after clearAllMocks
    vi.mocked(runPreflight).mockResolvedValue({ passed: true, checks: [] })
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        runRecord: { run_id: "r1", status: "completed" },
        summary: "Scan completed with 0 findings",
        findingCount: 0,
      },
    } as never)
    vi.mocked(interpretExitCode).mockImplementation((code: number) => {
      if (code === 0) return { status: "COMPLETED" as const, category: "SUCCESS", message: "" }
      if (code === 2)
        return { status: "COMPLETED" as const, category: "VULNERABILITIES_FOUND", message: "" }
      return {
        status: "FAILED" as const,
        category: "ENGINE_ERROR",
        message: `Engine error (code ${code})`,
      }
    })
    vi.mocked(persistFindings).mockResolvedValue([])
    vi.mocked(updateScanStatus).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(completeScanWithScore).mockResolvedValue({} as never)
    vi.mocked(qualifyReferralForWorkspace).mockResolvedValue(null)
    vi.mocked(cleanupEngineWorkspace).mockResolvedValue(undefined)
    vi.mocked(prisma.target.findFirst).mockResolvedValue(mockTarget as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.scan.findUnique).mockResolvedValue({ status: "RUNNING" } as never)
    vi.mocked(runScannerOrchestrator).mockResolvedValue({
      allFindings: [],
      engineFindings: [],
      scaFindings: [],
      secretsFindings: [],
      stats: {
        total: 0,
        bySeverity: {},
        byConfidence: { high: 0, medium: 0, low: 0 },
        verified: 0,
        unverified: 0,
        falsePositiveRisk: { low: 0, medium: 0, high: 0 },
      },
      filteredFalsePositives: 0,
    } as never)
  })

  it("completes successfully when engine returns exit code 0", async () => {
    const result = await processScanJob(mockJob)

    expect(result.status).toBe("completed")
    expect(result.summary).toBe("Scan completed with 0 findings")
    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "PREFLIGHT")
    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "RUNNING")
    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "VERIFYING")
    expect(completeScanWithScore).toHaveBeenCalledWith("scan-1", "Scan completed with 0 findings")
    expect(runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 1.2 }),
      "scan-1",
      undefined,
      expect.any(Function)
    )
  })

  it("uses the selected workspace policy budget for the engine cap", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      maxBudgetUsd: { toNumber: () => 6.5 },
    } as never)
    const policyJob = {
      id: "job-policy-1",
      data: {
        scanId: "scan-1",
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
        policyId: "policy-1",
      },
    } as never

    await processScanJob(policyJob)

    expect(prisma.policy.findFirst).toHaveBeenCalledWith({
      where: { id: "policy-1", workspaceId: "ws-1", deletedAt: null },
      select: { maxBudgetUsd: true },
    })
    expect(runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 6.5 }),
      "scan-1",
      undefined,
      expect.any(Function)
    )
  })

  it("keeps a completed scan completed when a completion notification fails", async () => {
    vi.mocked(notifyScanCompleted).mockRejectedValueOnce(
      new Error("notification provider unavailable")
    )

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("completed")
    expect(completeScanWithScore).toHaveBeenCalledWith("scan-1", "Scan completed with 0 findings")
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "FAILED", expect.anything())
  })

  it("keeps a completed scan completed when referral accounting fails", async () => {
    vi.mocked(qualifyReferralForWorkspace).mockRejectedValueOnce(
      new Error("referral database unavailable")
    )

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("completed")
    expect(completeScanWithScore).toHaveBeenCalledWith("scan-1", "Scan completed with 0 findings")
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "FAILED", expect.anything())
  })

  it("fails when preflight fails", async () => {
    vi.mocked(runPreflight).mockResolvedValue({
      passed: false,
      checks: [],
      errorCategory: "PREFLIGHT",
      errorMessage: "Target not found",
    })

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("failed")
    expect(result.errorCategory).toBe("PREFLIGHT")
    expect(result.errorMessage).toBe("Target not found")
  })

  it("fails when target disappears after preflight", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("failed")
    expect(result.errorCategory).toBe("TARGET_NOT_FOUND")
  })

  it("fails when engine returns error exit code", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 3,
      output: {
        vulnerabilities: [],
        runRecord: null,
        summary: "Engine failed",
        findingCount: 0,
      },
    } as never)
    vi.mocked(interpretExitCode).mockReturnValue({
      status: "FAILED" as const,
      category: "ENGINE_ERROR",
      message: "Engine error (code 3)",
    })

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("failed")
    expect(result.errorCategory).toBe("ENGINE_ERROR")
  })

  it("stops without overwriting a cancellation reported by the engine", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: -1,
      cancelled: true,
      output: {
        vulnerabilities: [],
        runRecord: null,
        summary: "Cancelled",
        findingCount: 0,
      },
    } as never)

    const result = await processScanJob(mockJob)

    expect(result).toMatchObject({ status: "failed", errorCategory: "CANCELLED" })
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "VERIFYING")
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "FAILED", expect.anything())
  })

  it("reports a distinct TIMEOUT category when the engine times out", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: -1,
      timedOut: true,
      output: {
        vulnerabilities: [],
        runRecord: null,
        summary: "Timed out",
        findingCount: 0,
      },
    } as never)

    const result = await processScanJob(mockJob)

    expect(result).toMatchObject({ status: "failed", errorCategory: "TIMEOUT" })
    // Timeout is terminal — it must not fall through to the scanner/verify phase.
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "VERIFYING")
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "TIMEOUT" })
    )
  })

  it("catches unexpected errors and marks scan as FAILED", async () => {
    vi.mocked(runPreflight).mockRejectedValue(new Error("Unexpected DB error") as never)

    const result = await processScanJob(mockJob)

    expect(result.status).toBe("failed")
    expect(result.errorMessage).toBe("Unexpected DB error")
  })

  it("rethrows a transient failure while BullMQ attempts remain", async () => {
    vi.mocked(runPreflight).mockRejectedValue(new Error("temporary database error") as never)
    const retryingJob = {
      id: "job-retry-1",
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        scanId: "scan-1",
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      },
    } as never

    await expect(processScanJob(retryingJob)).rejects.toThrow("temporary database error")
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "FAILED", expect.anything())
  })

  it("always cleans up engine workspace", async () => {
    await processScanJob(mockJob)

    expect(cleanupEngineWorkspace).toHaveBeenCalledWith("lyrashield_runs/scan-1")
  })

  it("transitions through VERIFYING status before completion", async () => {
    await processScanJob(mockJob)

    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "VERIFYING")
  })

  it("persists findings from engine output", async () => {
    const vulns = [{ id: "v1", title: "XSS", severity: "high", timestamp: "now" }]
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 2,
      output: {
        vulnerabilities: vulns,
        runRecord: { run_id: "r1", status: "completed" },
        summary: "1 finding",
        findingCount: 1,
      },
    } as never)
    vi.mocked(interpretExitCode).mockReturnValue({
      status: "COMPLETED" as const,
      category: "VULNERABILITIES_FOUND",
      message: "",
    })

    await processScanJob(mockJob)

    expect(runScannerOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        targetId: "target-1",
        engineFindings: vulns,
        workspaceDir: "lyrashield_runs/scan-1",
      })
    )
    expect(persistFindings).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [],
    })
  })
})
