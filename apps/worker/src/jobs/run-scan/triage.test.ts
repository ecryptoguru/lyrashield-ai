import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  addScanEvent: vi.fn(),
  resolveAccountBilling: vi.fn(),
  runWithAccountContext: vi.fn(),
  runEngineTriage: vi.fn(),
  resolveEngineProfile: vi.fn(),
  resolveScannerPhaseTimeoutMs: vi.fn(),
  persistEngineUsageCheckpoint: vi.fn(),
  env: {
    LYRASHIELD_AI_TRIAGE_ENABLED: "1",
    LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD: 0.2,
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/billing", () => ({ resolveAccountBilling: mocks.resolveAccountBilling }))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/db", () => ({
  addScanEvent: mocks.addScanEvent,
  runWithAccountContext: mocks.runWithAccountContext,
}))
vi.mock("@lyrashield/logger", () => ({ logger: mocks.logger }))
vi.mock("../../engine/runner", () => ({
  resolveEngineProfile: mocks.resolveEngineProfile,
  runEngineTriage: mocks.runEngineTriage,
}))
vi.mock("./lifecycle-utils", () => ({
  resolveScannerPhaseTimeoutMs: mocks.resolveScannerPhaseTimeoutMs,
}))
vi.mock("./usage", () => ({
  persistEngineUsageCheckpoint: mocks.persistEngineUsageCheckpoint,
}))

import type { AISecuritySignal, EngineTriageArtifact } from "@lyrashield/security"
import { runEngineTriageOverlay } from "./triage"

const checksum = "a".repeat(64)
const sourceRevision = "b".repeat(40)
const signal: AISecuritySignal = {
  controlId: "AI-01",
  ruleId: "AI-01.example",
  owaspMapping: "LLM01:2025",
  state: "DETECTED",
  severity: "MEDIUM",
  file: "src/model.ts",
  snippet: "bounded model input",
  remediation: "Validate model input",
  evidenceSource: "deterministic",
  detectorVersion: "ai-app-security/2026-08-21.1",
  evidenceChecksum: checksum,
}

const completedArtifact: EngineTriageArtifact = {
  schemaVersion: "ai-security-triage/1.0",
  status: "COMPLETED",
  terminalReason: null,
  policyVersion: "ai-security-triage-policy/1.0",
  modelRoute: "azure_ai/gpt-6-luna",
  inputChecksum: checksum,
  cacheKey: "c".repeat(64),
  redactionReceipt: {
    policyVersion: "ai-security-triage-policy/1.0",
    inputChecksum: checksum,
    redactedFieldCounts: { "[SECRET]": 1 },
    boundedExcerptBytes: 128,
  },
  results: [
    {
      findingIdentity: checksum,
      disposition: "LIKELY_VALID",
      confidence: 0.91,
      explanation: "The bounded evidence supports this finding.",
      evidenceChecksum: checksum,
    },
  ],
}

function usage(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    request_count: 1,
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    model_usage_buckets: [
      {
        model: "azure_ai/gpt-6-luna",
        standard_input_tokens: inputTokens,
        standard_cached_input_tokens: 0,
        standard_cache_write_input_tokens: 0,
        standard_output_tokens: outputTokens,
        long_input_tokens: 0,
        long_cached_input_tokens: 0,
        long_cache_write_input_tokens: 0,
        long_output_tokens: 0,
      },
    ],
  }
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    scanId: "scan-1",
    scope: { workspaceId: "ws-1", targetId: "target-1", targetType: "REPO" },
    sponsorAccountId: "account-1",
    mode: "STANDARD",
    deterministicRetest: false,
    agentMinuteTerminalError: null,
    hasGlobalScanTimeout: () => false,
    isScanCancelled: vi.fn(async () => false),
    engineResult: {
      sourceRevision,
      output: {
        runRecord: {
          llm_usage: usage(100, 20),
          webSearchCostUsd: [{ cost: 0.01 }],
        },
      },
    },
    aiSecuritySignals: [signal],
    billedCostUsd: 0.1,
    costReconciled: true,
    budgetExceeded: false,
    maxBudgetUsd: 2,
    scanRuntimeBudgetMs: 60_000,
    elapsedScanMs: () => 10_000,
    ...overrides,
  }
}

describe("runEngineTriageOverlay", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.env.LYRASHIELD_AI_TRIAGE_ENABLED = "1"
    mocks.env.LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD = 0.2
    mocks.resolveAccountBilling.mockResolvedValue({ effectivePlan: "PRO" })
    mocks.runWithAccountContext.mockImplementation(
      async (_accountId: string, callback: () => unknown) => callback()
    )
    mocks.runEngineTriage.mockResolvedValue({
      artifact: completedArtifact,
      llmUsage: usage(25, 5),
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })
    mocks.resolveEngineProfile.mockReturnValue({ model: "azure_ai/gpt-6-luna" })
    mocks.resolveScannerPhaseTimeoutMs.mockReturnValue(15_000)
    mocks.persistEngineUsageCheckpoint.mockResolvedValue({
      budgetExceeded: false,
      billedCostUsd: 0.17,
      costReconciled: true,
      reconciliationReason: undefined,
    })
    mocks.addScanEvent.mockResolvedValue(undefined)
  })

  it("applies the non-authoritative artifact and checkpoints merged provider usage", async () => {
    const input = params()

    const result = await runEngineTriageOverlay(input as never)

    expect(result.aiSecuritySignals).toHaveLength(1)
    expect(result.aiSecuritySignals[0]).toMatchObject({
      state: "DETECTED",
      severity: "MEDIUM",
      evidenceChecksum: checksum,
      triage: {
        disposition: "LIKELY_VALID",
        confidence: 91,
        modelRoute: "azure_ai/gpt-6-luna",
      },
    })
    expect(result.triageSnapshot).toMatchObject({ status: "COMPLETED", resultCount: 1 })
    expect(result).toMatchObject({
      budgetExceeded: false,
      billedCostUsd: 0.17,
      costReconciled: true,
    })
    expect(mocks.runWithAccountContext).toHaveBeenCalledWith("account-1", expect.any(Function))
    expect(mocks.runEngineTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        profile: { model: "azure_ai/gpt-6-luna" },
        maxBudgetUsd: 0.2,
        timeoutMs: 15_000,
      })
    )
    expect(mocks.persistEngineUsageCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        maxBudgetUsd: 2,
        webSearchCostUsd: [{ cost: 0.01 }],
        usageExpected: true,
        llmUsage: expect.objectContaining({
          request_count: 2,
          input_tokens: 125,
          output_tokens: 25,
          total_tokens: 150,
          model_usage_buckets: [
            expect.objectContaining({
              model: "azure_ai/gpt-6-luna",
              standard_input_tokens: 125,
              standard_output_tokens: 25,
            }),
          ],
        }),
      })
    )
    expect(mocks.addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "ai_security_triage",
      "info",
      expect.any(String),
      expect.objectContaining({ status: "COMPLETED", resultCount: 1, terminalReason: null })
    )
    expect(result.triageTerminalReason).toBeNull()
  })

  it.each(["exact_cache", "singleflight"])(
    "preserves the paid scan checkpoint when triage is reused from %s",
    async (source) => {
      mocks.runEngineTriage.mockResolvedValueOnce({
        source,
        artifact: completedArtifact,
        ...(source === "exact_cache"
          ? {
              reuseReceipt: {
                version: "ai-result-reuse/1.0",
                artifactSha256: "d".repeat(64),
                createdAt: "2026-10-06T00:00:00.000Z",
                expiresAt: "2026-10-07T00:00:00.000Z",
                currentProviderRequests: 0,
                currentProviderCostUsd: 0,
              },
            }
          : {}),
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      })
      // An empty usage checkpoint invalidates the already reconciled receipt.
      mocks.persistEngineUsageCheckpoint.mockResolvedValueOnce({
        budgetExceeded: false,
        billedCostUsd: null,
        costReconciled: false,
        reconciliationReason: "Provider usage unavailable",
      })
      const result = await runEngineTriageOverlay(params() as never)
      expect(result).toMatchObject({ billedCostUsd: 0.1, costReconciled: true })
      expect(result.triageSnapshot).toMatchObject({ status: "COMPLETED", resultCount: 1 })
      expect(result.aiSecuritySignals[0]?.triage?.disposition).toBe("LIKELY_VALID")
      expect(mocks.persistEngineUsageCheckpoint).not.toHaveBeenCalled()
    }
  )

  it("preserves the paid checkpoint when a shared attempt has no usable artifact", async () => {
    mocks.runEngineTriage.mockResolvedValueOnce({
      source: "singleflight",
      artifact: null,
      exitCode: 1,
      timedOut: false,
      cancelled: false,
    })
    mocks.persistEngineUsageCheckpoint.mockResolvedValueOnce({
      billedCostUsd: null,
      costReconciled: false,
      budgetExceeded: false,
    })
    const result = await runEngineTriageOverlay(params() as never)
    expect(result).toMatchObject({
      billedCostUsd: 0.1,
      costReconciled: true,
      triageTerminalReason: "TRIAGE_ARTIFACT_UNAVAILABLE",
    })
    expect(result.aiSecuritySignals).toEqual([signal])
    expect(mocks.persistEngineUsageCheckpoint).not.toHaveBeenCalled()
  })

  it.each([
    ["failed", "FAILED", "TRIAGE_COMMAND_FAILED"],
    ["budget-stopped", "BUDGET_STOPPED", "TRIAGE_BUDGET_EXHAUSTED"],
  ] as const)(
    "preserves deterministic signals for a %s artifact",
    async (_label, status, reason) => {
      mocks.runEngineTriage.mockResolvedValueOnce({
        artifact: { ...completedArtifact, status, terminalReason: reason },
        llmUsage: usage(25, 5),
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      })

      const result = await runEngineTriageOverlay(params() as never)

      expect(result.aiSecuritySignals).toEqual([signal])
      expect(result.triageSnapshot).toMatchObject({
        status,
        terminalReason: reason,
        resultCount: 1,
      })
      expect(result.triageTerminalReason).toBe(reason)
      expect(mocks.addScanEvent).toHaveBeenCalledWith(
        "scan-1",
        "ai_security_triage",
        "warning",
        expect.any(String),
        expect.objectContaining({ status, terminalReason: reason, resultCount: 1 })
      )
    }
  )

  it("keeps provider accounting when the command returns usage without a terminal artifact", async () => {
    mocks.runEngineTriage.mockResolvedValueOnce({
      artifact: undefined,
      llmUsage: usage(25, 5),
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })

    const result = await runEngineTriageOverlay(params() as never)

    expect(result.aiSecuritySignals).toEqual([signal])
    expect(result.triageSnapshot).toBeUndefined()
    expect(result.triageTerminalReason).toBe("TRIAGE_ARTIFACT_UNAVAILABLE")
    expect(result).toMatchObject({ billedCostUsd: 0.17, costReconciled: true })
    expect(mocks.persistEngineUsageCheckpoint).toHaveBeenCalledOnce()
    expect(mocks.addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "ai_security_triage",
      "info",
      expect.any(String),
      expect.objectContaining({ status: "DISABLED", terminalReason: "TRIAGE_ARTIFACT_UNAVAILABLE" })
    )
  })

  it("keeps deterministic scan findings and accounting untouched when a paid overlay is budget-ineligible", async () => {
    const input = params({ billedCostUsd: 2, maxBudgetUsd: 2 })

    const result = await runEngineTriageOverlay(input as never)

    expect(result.aiSecuritySignals).toEqual([signal])
    expect(result.triageSnapshot).toBeUndefined()
    expect(result.triageTerminalReason).toBe("TRIAGE_BUDGET_EXHAUSTED")
    expect(result.billedCostUsd).toBe(2)
    expect(mocks.runEngineTriage).not.toHaveBeenCalled()
    expect(mocks.persistEngineUsageCheckpoint).not.toHaveBeenCalled()
    expect(mocks.addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "ai_security_triage",
      "info",
      expect.any(String),
      expect.objectContaining({ status: "DISABLED", terminalReason: "TRIAGE_BUDGET_EXHAUSTED" })
    )
  })

  it("does not fail the deterministic scan when the overlay command throws", async () => {
    mocks.runEngineTriage.mockRejectedValueOnce(new Error("triage command failed"))
    const input = params()

    const result = await runEngineTriageOverlay(input as never)

    expect(result.aiSecuritySignals).toEqual([signal])
    expect(result.triageSnapshot).toBeUndefined()
    expect(result.triageTerminalReason).toBe("TRIAGE_COMMAND_FAILED")
    expect(result.billedCostUsd).toBe(0.1)
    expect(mocks.persistEngineUsageCheckpoint).not.toHaveBeenCalled()
    expect(mocks.addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "ai_security_triage",
      "info",
      expect.any(String),
      expect.objectContaining({ status: "DISABLED", terminalReason: "TRIAGE_COMMAND_FAILED" })
    )
  })

  it("refuses to apply an artifact whose accompanying provider usage cannot be merged", async () => {
    mocks.persistEngineUsageCheckpoint.mockResolvedValueOnce({
      budgetExceeded: false,
      billedCostUsd: null,
      costReconciled: false,
      reconciliationReason: "Per-request model usage was unavailable",
    })
    mocks.runEngineTriage.mockResolvedValueOnce({
      artifact: completedArtifact,
      llmUsage: { request_count: 1, input_tokens: 25 },
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })
    const input = params()

    const result = await runEngineTriageOverlay(input as never)

    expect(result.aiSecuritySignals).toEqual([signal])
    expect(result.triageSnapshot).toMatchObject({
      status: "FAILED",
      terminalReason: "TRIAGE_ACCOUNTING_UNAVAILABLE",
      resultCount: 0,
    })
    expect(result.triageTerminalReason).toBe("TRIAGE_ACCOUNTING_UNAVAILABLE")
    expect(result).toMatchObject({
      budgetExceeded: false,
      billedCostUsd: null,
      costReconciled: false,
      reconciliationReason: "Per-request model usage was unavailable",
    })
    expect(mocks.persistEngineUsageCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        maxBudgetUsd: 2,
        llmUsage: undefined,
        usageExpected: true,
      })
    )
    expect(mocks.addScanEvent).toHaveBeenCalledWith(
      "scan-1",
      "ai_security_triage",
      "warning",
      expect.any(String),
      expect.objectContaining({
        status: "FAILED",
        terminalReason: "TRIAGE_ACCOUNTING_UNAVAILABLE",
        resultCount: 0,
      })
    )
  })

  it.each([
    ["deterministic retest", { deterministicRetest: true }],
    ["an already-terminal scan", { agentMinuteTerminalError: { status: "FAILED" } }],
    ["a global timeout", { hasGlobalScanTimeout: () => true }],
  ])("skips engine triage for %s", async (_reason, overrides) => {
    const result = await runEngineTriageOverlay(params(overrides) as never)

    expect(result.aiSecuritySignals).toEqual([signal])
    expect(mocks.runEngineTriage).not.toHaveBeenCalled()
    expect(mocks.persistEngineUsageCheckpoint).not.toHaveBeenCalled()
  })
})
