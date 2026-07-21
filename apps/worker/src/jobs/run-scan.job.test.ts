import { describe, it, expect, vi, beforeEach } from "vitest"

const completeUsage = vi.hoisted(() => ({
  request_count: 1,
  input_tokens: 1_000,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 100,
  standard_input_tokens: 1_000,
  standard_cached_input_tokens: 0,
  standard_cache_write_input_tokens: 0,
  standard_output_tokens: 100,
  long_input_tokens: 0,
  long_cached_input_tokens: 0,
  long_cache_write_input_tokens: 0,
  long_output_tokens: 0,
}))

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
      update: vi.fn(),
      updateMany: vi.fn(),
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
  runEngine: vi.fn().mockImplementation(({ scanId }: { scanId: string }) => ({
    exitCode: 0,
    output: {
      vulnerabilities: [],
      findingsComplete: true,
      runRecord: {
        run_id: scanId,
        run_name: scanId,
        status: "completed",
        llm_usage: completeUsage,
      },
      summary: "Scan completed with 0 findings",
      findingCount: 0,
    },
  })),
  cleanupEngineWorkspace: vi.fn().mockResolvedValue(undefined),
  resolveEngineProfile: vi.fn((mode: string) => ({
    model:
      mode === "DEEP" || mode === "CUSTOM" ? "azure_ai/gpt-5.6-terra" : "azure_ai/gpt-5.6-luna",
    reasoningEffort: "medium",
    delegateModel: "azure_ai/gpt-5.6-luna",
    delegateReasoningEffort: "medium",
  })),
  resolveEngineTimeoutMs: vi.fn((minutes?: number | null) =>
    typeof minutes === "number" && minutes > 0 ? minutes * 60 * 1000 : 30 * 60 * 1000
  ),
  interpretExitCode: vi.fn((code: number) => {
    if (code === 0) return { status: "COMPLETED", category: "SUCCESS" }
    if (code === 2) return { status: "COMPLETED", category: "VULNERABILITIES_FOUND" }
    return { status: "FAILED", category: "ENGINE_ERROR", message: `Engine error (code ${code})` }
  }),
}))

vi.mock("../engine/evidence-storage", () => ({
  assertEvidenceStorageConfigured: vi.fn(),
  EvidenceStorageConfigurationError: class EvidenceStorageConfigurationError extends Error {
    constructor() {
      super("Evidence storage is not configured")
      this.name = "EVIDENCE_STORAGE_CONFIGURATION"
    }
  },
}))

vi.mock("../engine/finding-persister", () => ({
  persistFindings: vi.fn().mockResolvedValue([]),
}))

vi.mock("../engine/result-integrity", () => ({
  persistResultManifest: vi.fn().mockResolvedValue(undefined),
  markRetestsRunning: vi.fn().mockResolvedValue(undefined),
  completeRetestsForScan: vi.fn().mockResolvedValue(undefined),
  failTerminalRetestsForScan: vi.fn().mockResolvedValue(undefined),
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
    urlFindings: [],
    agentConfigFindings: [],
    coverageIssues: [],
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

import { extractActualCostUsd, extractUsageSummary, processScanJob } from "./run-scan.job"
import { runPreflight } from "./preflight.job"
import { runEngine, cleanupEngineWorkspace, interpretExitCode } from "../engine/runner"
import { persistFindings } from "../engine/finding-persister"
import { completeRetestsForScan, persistResultManifest } from "../engine/result-integrity"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import {
  assertEvidenceStorageConfigured,
  EvidenceStorageConfigurationError,
} from "../engine/evidence-storage"
import { notifyScanCompleted } from "../notifications"
import {
  completeScanWithScore,
  qualifyReferralForWorkspace,
  updateScanStatus,
  addScanEvent,
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

const mockRepoTarget = {
  id: "target-1",
  name: "Test Target",
  type: "REPO",
  url: null,
  repoFullName: "acme/test-target",
  deletedAt: null,
}

const mockUrlTarget = {
  ...mockRepoTarget,
  type: "WEB_APP",
  url: "https://example.com",
  repoFullName: null,
}

it("keeps URL targets out of the unpinned external engine", async () => {
  vi.mocked(prisma.target.findFirst).mockResolvedValue(mockUrlTarget as never)
  vi.mocked(prisma.policy.findFirst).mockResolvedValue(null)

  await expect(processScanJob(mockJob)).resolves.toMatchObject({ status: "completed" })

  expect(runEngine).not.toHaveBeenCalled()
  expect(addScanEvent).toHaveBeenCalledWith(
    "scan-1",
    "engine_skipped",
    "info",
    expect.any(String),
    { targetType: "WEB_APP" }
  )
})

it("extracts only finite non-negative engine cost signals", () => {
  expect(extractActualCostUsd({ total_cost_usd: 3.25 })).toBe(3.25)
  expect(extractActualCostUsd({ cost: -1 })).toBeNull()
  expect(extractActualCostUsd({ cost: 1_000_000 })).toBeNull()
  expect(extractActualCostUsd({ tokens: 100 })).toBeNull()
})

it("extracts a privacy-bounded provider usage summary", () => {
  expect(
    extractUsageSummary({
      request_count: 3,
      input_tokens: 12_345,
      cached_input_tokens: 4_000,
      cache_write_input_tokens: 500,
      output_tokens: 678,
      total_cost_usd: 1.234567,
      prompt: "must not be retained",
    })
  ).toEqual({
    requestCount: 3,
    inputTokens: 12_345,
    cachedInputTokens: 4_000,
    cacheWriteInputTokens: 500,
    outputTokens: 678,
    pricingBuckets: null,
    modelPricingBuckets: null,
    engineReportedCostUsd: 1.234567,
  })
  expect(extractUsageSummary({ request_count: 1.5, input_tokens: 2_147_483_648 })).toEqual({
    requestCount: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    pricingBuckets: null,
    modelPricingBuckets: null,
    engineReportedCostUsd: null,
  })
})

describe("processScanJob", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default mock implementations after clearAllMocks
    vi.mocked(runPreflight).mockResolvedValue({ passed: true, checks: [] })
    vi.mocked(runEngine).mockImplementation(
      ({ scanId }: { scanId: string }) =>
        ({
          exitCode: 0,
          output: {
            vulnerabilities: [],
            findingsComplete: true,
            runRecord: {
              run_id: scanId,
              run_name: scanId,
              status: "completed",
              llm_usage: completeUsage,
            },
            summary: "Scan completed with 0 findings",
            findingCount: 0,
          },
        }) as never
    )
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
    vi.mocked(prisma.target.findFirst).mockResolvedValue(mockRepoTarget as never)
    vi.mocked(prisma.policy.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.scan.findUnique).mockResolvedValue({ status: "RUNNING" } as never)
    vi.mocked(prisma.scan.update).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(prisma.scan.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(runScannerOrchestrator).mockResolvedValue({
      allFindings: [],
      engineFindings: [],
      scaFindings: [],
      secretsFindings: [],
      urlFindings: [],
      agentConfigFindings: [],
      coverageIssues: [],
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
    expect(vi.mocked(completeRetestsForScan).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(completeScanWithScore).mock.invocationCallOrder[0]!
    )
    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: { summary: "Scan completed with 0 findings" },
    })
    expect(runEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBudgetUsd: 3.2,
        instruction: expect.stringContaining("vibe-security-50/1.0.0"),
      }),
      "scan-1",
      30 * 60 * 1000,
      expect.any(Function)
    )
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "coverage_contract",
      "info",
      expect.stringContaining("43 machine-testable controls"),
      expect.objectContaining({ totalControls: 50, evidenceControlsRequired: 7 })
    )
  })

  it("uses the selected workspace policy budget for the engine cap", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      maxBudgetUsd: { toNumber: () => 6.5 },
      maxDurationMinutes: 75,
    } as never)
    const policyJob = {
      id: "job-policy-1",
      discard: vi.fn(),
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
      select: { maxBudgetUsd: true, maxDurationMinutes: true },
    })
    expect(runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 6.5 }),
      "scan-1",
      75 * 60 * 1000,
      expect.any(Function)
    )
  })

  it("caps deep scan total runtime to the 30-minute target by balancing engine and scanner phases", async () => {
    vi.mocked(prisma.policy.findFirst).mockResolvedValue({
      maxBudgetUsd: { toNumber: () => 3.2 },
      maxDurationMinutes: 75,
    } as never)
    const deepPolicyJob = {
      id: "job-deep-policy-1",
      discard: vi.fn(),
      data: {
        scanId: "scan-1",
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "DEEP",
        policyId: "policy-deep",
      },
    } as never

    await processScanJob(deepPolicyJob)

    expect(prisma.policy.findFirst).toHaveBeenCalledWith({
      where: { id: "policy-deep", workspaceId: "ws-1", deletedAt: null },
      select: { maxBudgetUsd: true, maxDurationMinutes: true },
    })
    expect(runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 3.2 }),
      "scan-1",
      20 * 60 * 1000,
      expect.any(Function)
    )
    expect(runScannerOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ scannerPhaseTimeoutMs: 10 * 60 * 1000 })
    )
  })

  it("stops an over-budget scan and caps its recorded bill", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        findingsComplete: true,
        runRecord: {
          run_id: "scan-1",
          run_name: "scan-1",
          status: "completed",
          llm_usage: {
            request_count: 1,
            input_tokens: 3_500_000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            standard_input_tokens: 3_500_000,
            standard_cached_input_tokens: 0,
            standard_cache_write_input_tokens: 0,
            standard_output_tokens: 0,
            long_input_tokens: 0,
            long_cached_input_tokens: 0,
            long_cache_write_input_tokens: 0,
            long_output_tokens: 0,
            total_cost_usd: 3.5,
          },
        },
        summary: "Engine completed above budget",
        findingCount: 0,
      },
    } as never)

    await expect(processScanJob(mockJob)).resolves.toEqual({
      status: "failed",
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
    })

    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: {
        providerCostUsd: "3.500000",
        billedCostUsd: "3.200000",
        actualCostCents: 320,
        llmRequestCount: 1,
        llmInputTokens: 3_500_000,
        llmCachedInputTokens: 0,
        llmOutputTokens: 0,
      },
    })
    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: {
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: "Protected run limit reached",
        actualCostCents: 320,
      },
    })
    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "STOPPED_BUDGET", {
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
      actualCostCents: 320,
    })
    expect(persistFindings).toHaveBeenCalled()
    expect(persistResultManifest).toHaveBeenCalled()
    expect(completeScanWithScore).not.toHaveBeenCalled()
  })

  it("uses the permanent GPT-5.6 rate card when engine cost is unavailable", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        findingsComplete: true,
        runRecord: {
          run_id: "scan-1",
          run_name: "scan-1",
          status: "completed",
          llm_usage: {
            request_count: 7,
            input_tokens: 18_420,
            cached_input_tokens: 6_100,
            cache_write_input_tokens: 0,
            output_tokens: 2_310,
            standard_input_tokens: 18_420,
            standard_cached_input_tokens: 6_100,
            standard_cache_write_input_tokens: 0,
            standard_output_tokens: 2_310,
            long_input_tokens: 0,
            long_cached_input_tokens: 0,
            long_cache_write_input_tokens: 0,
            long_output_tokens: 0,
          },
        },
        summary: "Engine completed without a cost field",
        findingCount: 0,
      },
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({ status: "completed" })

    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: {
        providerCostUsd: null,
        billedCostUsd: "0.026790",
        actualCostCents: 3,
        llmRequestCount: 7,
        llmInputTokens: 18_420,
        llmCachedInputTokens: 6_100,
        llmOutputTokens: 2_310,
      },
    })
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "llm_usage",
      "info",
      "AI usage counters recorded",
      expect.objectContaining({
        calculatedCostUsd: 0.02679,
        costSource: "openai_rate_card",
        pricingEffectiveDate: "2026-07-09",
        reconciliationStatus: "rate_card_only",
      })
    )
  })

  it("completes the scan but records no bill when provider telemetry disagrees", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        findingsComplete: true,
        runRecord: {
          run_id: "scan-1",
          run_name: "scan-1",
          status: "completed",
          llm_usage: {
            request_count: 7,
            input_tokens: 18_420,
            cached_input_tokens: 6_100,
            cache_write_input_tokens: 0,
            output_tokens: 2_310,
            total_cost_usd: 0.02,
            standard_input_tokens: 18_420,
            standard_cached_input_tokens: 6_100,
            standard_cache_write_input_tokens: 0,
            standard_output_tokens: 2_310,
            long_input_tokens: 0,
            long_cached_input_tokens: 0,
            long_cache_write_input_tokens: 0,
            long_output_tokens: 0,
          },
        },
        summary: "Engine completed with provider telemetry",
        findingCount: 0,
      },
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({ status: "completed" })

    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: expect.objectContaining({
        providerCostUsd: "0.020000",
        billedCostUsd: null,
        actualCostCents: null,
      }),
    })
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "llm_usage",
      "info",
      "AI usage counters recorded",
      expect.objectContaining({
        calculatedCostUsd: 0.02679,
        engineReportedCostUsd: 0.02,
        costSource: "rate_card_and_engine_reported",
        reconciliationStatus: "mismatch",
      })
    )
  })

  it("completes a valid scan when provider usage is unavailable without inventing a cost", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        findingsComplete: true,
        runRecord: { run_id: "scan-1", run_name: "scan-1", status: "completed" },
        summary: "Engine completed without usage telemetry",
        findingCount: 0,
      },
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({ status: "completed" })
    expect(prisma.scan.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billedCostUsd: expect.any(String) }),
      })
    )
    expect(addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "llm_usage_unavailable",
      "warning",
      expect.any(String)
    )
  })

  it("checkpoints usage before a downstream scanner failure", async () => {
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 0,
      output: {
        vulnerabilities: [],
        findingsComplete: true,
        runRecord: {
          run_id: "scan-1",
          run_name: "scan-1",
          status: "completed",
          llm_usage: {
            request_count: 1,
            input_tokens: 1_000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 100,
            standard_input_tokens: 1_000,
            standard_cached_input_tokens: 0,
            standard_cache_write_input_tokens: 0,
            standard_output_tokens: 100,
            long_input_tokens: 0,
            long_cached_input_tokens: 0,
            long_cache_write_input_tokens: 0,
            long_output_tokens: 0,
            total_cost_usd: 0.0016,
          },
        },
        summary: "Engine completed",
        findingCount: 0,
      },
    } as never)
    vi.mocked(runScannerOrchestrator).mockRejectedValueOnce(new Error("scanner unavailable"))

    await expect(processScanJob(mockJob)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "scanner unavailable",
    })

    expect(prisma.scan.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: expect.objectContaining({
        providerCostUsd: "0.001600",
        billedCostUsd: "0.001600",
        llmRequestCount: 1,
      }),
    })
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
        findingsComplete: false,
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

  it("maps scanner timeout errors to TIMEOUT", async () => {
    vi.mocked(runScannerOrchestrator).mockRejectedValueOnce(
      new Error("Scanner phase timed out") as never
    )

    const result = await processScanJob(mockJob)

    expect(result).toMatchObject({ status: "failed", errorCategory: "TIMEOUT" })
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
    expect(prisma.scan.updateMany).toHaveBeenCalledWith({
      where: {
        id: "scan-1",
        status: { in: ["PREFLIGHT", "RUNNING", "VERIFYING"] },
      },
      data: { status: "QUEUED" },
    })
    expect(updateScanStatus).not.toHaveBeenCalledWith("scan-1", "FAILED", expect.anything())
  })

  it("resumes final scoring from an immutable manifest without replaying the scan", async () => {
    vi.mocked(prisma.scan.findUnique).mockResolvedValueOnce({
      status: "VERIFYING",
      summary: "Recovered finalization",
      resultManifest: { id: "manifest-1" },
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({
      status: "completed",
      summary: "Recovered finalization",
    })

    expect(completeScanWithScore).toHaveBeenCalledWith("scan-1", "Recovered finalization")
    expect(runEngine).not.toHaveBeenCalled()
    expect(runScannerOrchestrator).not.toHaveBeenCalled()
  })

  it("resumes a durable budget stop without completing the scan", async () => {
    vi.mocked(prisma.scan.findUnique).mockResolvedValueOnce({
      status: "VERIFYING",
      summary: "Stopped above budget",
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
      actualCostCents: 120,
      resultManifest: { id: "manifest-1" },
      events: [{ id: "event-1" }],
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({
      status: "failed",
      errorCategory: "BUDGET_EXCEEDED",
    })

    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "STOPPED_BUDGET", {
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
      actualCostCents: 120,
    })
    expect(completeScanWithScore).not.toHaveBeenCalled()
    expect(runEngine).not.toHaveBeenCalled()
  })

  it("fails safely instead of replaying an interrupted billable scan", async () => {
    vi.mocked(prisma.scan.findUnique).mockResolvedValueOnce({
      status: "RUNNING",
      summary: null,
      errorCategory: null,
      errorMessage: null,
      actualCostCents: null,
      resultManifest: null,
      events: [{ id: "billable-event" }],
    } as never)

    await expect(processScanJob(mockJob)).resolves.toMatchObject({
      status: "failed",
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
    })

    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
      errorMessage: "Provider-billable analysis was interrupted and was not replayed automatically",
    })
    expect(runEngine).not.toHaveBeenCalled()
  })

  it("does not rethrow a post-billing failure while attempts remain", async () => {
    vi.mocked(persistFindings).mockRejectedValue(new Error("post-billing database error") as never)
    const retryingJob = {
      id: "job-post-billing-error",
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

    await expect(processScanJob(retryingJob)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "post-billing database error",
    })
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorMessage: "post-billing database error" })
    )
  })

  it("fails closed without replaying a billable scan when evidence storage is unconfigured", async () => {
    vi.mocked(assertEvidenceStorageConfigured).mockImplementationOnce(() => {
      throw new EvidenceStorageConfigurationError()
    })
    const retryingJob = {
      id: "job-evidence-storage-1",
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

    await expect(processScanJob(retryingJob)).resolves.toMatchObject({
      status: "failed",
      errorCategory: "EVIDENCE_STORAGE_CONFIGURATION",
      errorMessage: "Evidence storage is not configured",
    })
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "EVIDENCE_STORAGE_CONFIGURATION" })
    )
  })

  it("always cleans up engine workspace", async () => {
    await processScanJob(mockJob)

    expect(cleanupEngineWorkspace).toHaveBeenCalledWith("lyrashield_runs/scan-1", "scan-1")
  })

  it("transitions through VERIFYING status before completion", async () => {
    await processScanJob(mockJob)

    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "VERIFYING")
  })

  it("persists findings from engine output", async () => {
    const vulns = [{ id: "v1", title: "XSS", severity: "high", timestamp: "now" }]
    vi.mocked(runEngine).mockResolvedValue({
      exitCode: 2,
      sourceCheckoutPath: "/tmp/strix_repos/r1/repo",
      output: {
        vulnerabilities: vulns,
        findingsComplete: true,
        runRecord: {
          run_id: "scan-1",
          run_name: "scan-1",
          status: "completed",
          llm_usage: completeUsage,
        },
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
        workspaceDir: "/tmp/strix_repos/r1/repo",
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
