import { resolveAccountBilling } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { addScanEvent, runWithAccountContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  applyEngineTriageArtifact,
  type AISecuritySignal,
  type EngineTriageArtifact,
} from "@lyrashield/security"
import { buildEngineTriageInput, eligibleForEngineTriage } from "../../engine/ai-security-triage"
import { mergeLlmUsage } from "../../engine/output-parser"
import { resolveEngineProfile, runEngineTriage, type EngineRunResult } from "../../engine/runner"
import type { ScanJobData } from "../../types"
import { resolveScannerPhaseTimeoutMs } from "./lifecycle-utils"
import { persistEngineUsageCheckpoint } from "./usage"
import type { ScanTerminalError } from "./settlement"

export type EngineTriageSnapshot = {
  status: "COMPLETED" | "DISABLED" | "FAILED" | "BUDGET_STOPPED"
  terminalReason: string | null
  policyVersion: string
  modelRoute: string
  inputChecksum: string
  redactionReceipt: string
  resultCount: number
}

export type EngineTriageOverlayResult = {
  aiSecuritySignals: AISecuritySignal[]
  triageSnapshot: EngineTriageSnapshot | undefined
  triageTerminalReason: string | null
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
}

function artifactSnapshot(
  artifact: EngineTriageArtifact,
  accountingAvailable = true
): EngineTriageSnapshot {
  return {
    status: accountingAvailable ? artifact.status : "FAILED",
    terminalReason: accountingAvailable ? artifact.terminalReason : "TRIAGE_ACCOUNTING_UNAVAILABLE",
    policyVersion: artifact.policyVersion,
    modelRoute: artifact.modelRoute,
    inputChecksum: artifact.inputChecksum,
    redactionReceipt: artifact.redactionReceipt.inputChecksum,
    resultCount: accountingAvailable ? artifact.results.length : 0,
  }
}

type OverlayAttemptOutcome = {
  aiSecuritySignals: AISecuritySignal[]
  triageSnapshot: EngineTriageSnapshot | undefined
  triageTerminalReason: string | null
  cacheOperations: {
    readCommands: number
    writeCommands: number
    bytesRead: number
    bytesWritten: number
  }
}

async function attemptRepoTriageOverlay(args: {
  scanId: string
  workspaceId: string
  targetId: string
  triageInput: NonNullable<ReturnType<typeof buildEngineTriageInput>>
  maxBudgetUsd: number
  scanRuntimeBudgetMs: number
  elapsedScanMs: () => number
  hasGlobalScanTimeout: () => boolean
  isScanCancelled: () => Promise<boolean>
  engineResult: EngineRunResult
  aiSecuritySignals: AISecuritySignal[]
  updateAccounting: (llmUsage?: Record<string, unknown>) => Promise<void>
}): Promise<OverlayAttemptOutcome> {
  const {
    scanId,
    workspaceId,
    targetId,
    triageInput,
    scanRuntimeBudgetMs,
    elapsedScanMs,
    hasGlobalScanTimeout,
    isScanCancelled,
    engineResult,
    updateAccounting,
  } = args
  let aiSecuritySignals = args.aiSecuritySignals
  let triageSnapshot: EngineTriageSnapshot | undefined
  let triageTerminalReason: string | null = null
  let cacheOperations = { readCommands: 0, writeCommands: 0, bytesRead: 0, bytesWritten: 0 }
  try {
    const triageResult = await runEngineTriage({
      scanId,
      workspaceId,
      targetId,
      profile: resolveEngineProfile("STANDARD"),
      input: triageInput,
      maxBudgetUsd: args.maxBudgetUsd,
      timeoutMs: resolveScannerPhaseTimeoutMs(scanRuntimeBudgetMs, elapsedScanMs()),
      shouldCancel: async () => hasGlobalScanTimeout() || (await isScanCancelled()),
    })
    cacheOperations = triageResult.cacheOperations ?? cacheOperations
    const artifact = triageResult.artifact
    const reuseWithoutProviderRequest =
      triageResult.source === "singleflight" ||
      (triageResult.source === "exact_cache" && Boolean(triageResult.reuseReceipt))
    if (triageResult.llmUsage) {
      const mergedUsage = mergeLlmUsage(
        engineResult.output.runRecord?.llm_usage,
        triageResult.llmUsage
      )
      if (mergedUsage) {
        if (triageResult.llmUsage["accountingComplete"] === false)
          mergedUsage["accountingComplete"] = false
        await updateAccounting(mergedUsage)
        if (artifact) {
          aiSecuritySignals = applyEngineTriageArtifact(aiSecuritySignals, artifact)
          triageSnapshot = artifactSnapshot(artifact)
        }
      } else {
        // The overlay may have spent tokens even though its receipt cannot
        // be merged with the scan usage. Invalidate the total rather than
        // retaining a billable amount for only the engine phase.
        await updateAccounting()
        if (!artifact) {
          triageTerminalReason = "TRIAGE_ARTIFACT_UNAVAILABLE"
        } else {
          triageSnapshot = artifactSnapshot(artifact, false)
        }
      }
    } else if (artifact && reuseWithoutProviderRequest) {
      // An exact completed artifact makes no provider request. Preserve the
      // main scan's existing ledger and apply the same non-authoritative
      // overlay only after its provenance receipt has been validated.
      aiSecuritySignals = applyEngineTriageArtifact(aiSecuritySignals, artifact)
      triageSnapshot = {
        status: artifact.status,
        terminalReason: artifact.terminalReason,
        policyVersion: artifact.policyVersion,
        modelRoute: artifact.modelRoute,
        inputChecksum: artifact.inputChecksum,
        redactionReceipt: artifact.redactionReceipt.inputChecksum,
        resultCount: artifact.results.length,
      }
      logger.info("AI triage reused result applied", {
        scanId,
        source: triageResult.source,
        ...(triageResult.reuseReceipt
          ? { artifactSha256: triageResult.reuseReceipt.artifactSha256 }
          : {}),
        currentProviderRequests: 0,
        currentProviderCostUsd: 0,
      })
    } else if (reuseWithoutProviderRequest) {
      // A shared attempt without an artifact still made no request for this scan.
      // Keep its main-engine checkpoint; the terminal reason below records the gap.
    } else if (artifact) {
      await updateAccounting()
      triageSnapshot = { ...artifactSnapshot(artifact), resultCount: 0 }
    } else {
      await updateAccounting()
    }
    triageTerminalReason = triageSnapshot
      ? triageSnapshot.terminalReason
      : triageResult.cancelled
        ? "TRIAGE_CANCELLED"
        : triageResult.timedOut
          ? "TRIAGE_TIMEOUT"
          : "TRIAGE_ARTIFACT_UNAVAILABLE"
  } catch {
    // An additive overlay can never fail the deterministic scan.
    triageTerminalReason = "TRIAGE_COMMAND_FAILED"
  }
  return { aiSecuritySignals, triageSnapshot, triageTerminalReason, cacheOperations }
}

export async function runEngineTriageOverlay(params: {
  scanId: string
  scope: { workspaceId: string; targetId: string; targetType: string }
  sponsorAccountId: string
  mode: ScanJobData["mode"]
  deterministicRetest: boolean
  agentMinuteTerminalError: ScanTerminalError | null
  hasGlobalScanTimeout: () => boolean
  isScanCancelled: () => Promise<boolean>
  engineResult: EngineRunResult
  aiSecuritySignals: AISecuritySignal[]
  billedCostUsd: number | null
  costReconciled: boolean
  budgetExceeded: boolean
  reconciliationReason?: string
  maxBudgetUsd: number
  scanRuntimeBudgetMs: number
  elapsedScanMs: () => number
}): Promise<EngineTriageOverlayResult> {
  const {
    scanId,
    scope: { workspaceId, targetId, targetType },
    sponsorAccountId,
    mode,
    deterministicRetest,
    agentMinuteTerminalError,
    hasGlobalScanTimeout,
    isScanCancelled,
    engineResult,
    maxBudgetUsd,
    scanRuntimeBudgetMs,
    elapsedScanMs,
  } = params
  let aiSecuritySignals = params.aiSecuritySignals
  let triageSnapshot: EngineTriageSnapshot | undefined
  let budgetExceeded = params.budgetExceeded
  let billedCostUsd = params.billedCostUsd
  let costReconciled = params.costReconciled
  let reconciliationReason = params.reconciliationReason

  const updateAccounting = async (llmUsage?: Record<string, unknown>) => {
    const updatedAccounting = await persistEngineUsageCheckpoint({
      scanId,
      maxBudgetUsd,
      llmUsage,
      webSearchCostUsd: engineResult.output.runRecord?.webSearchCostUsd,
      usageExpected: true,
    })
    budgetExceeded = updatedAccounting.budgetExceeded
    billedCostUsd = updatedAccounting.billedCostUsd
    costReconciled = updatedAccounting.costReconciled
    reconciliationReason = updatedAccounting.reconciliationReason
  }

  const triageInput = buildEngineTriageInput(aiSecuritySignals, engineResult.sourceRevision)
  const triageFeatureEnabled =
    !deterministicRetest &&
    !agentMinuteTerminalError &&
    !hasGlobalScanTimeout() &&
    env.LYRASHIELD_AI_TRIAGE_ENABLED === "1"
  const workspacePlan =
    triageFeatureEnabled && triageInput
      ? await runWithAccountContext(sponsorAccountId, () => resolveAccountBilling(sponsorAccountId))
          .then((billing) => (billing ? { plan: billing.effectivePlan } : null))
          .catch(() => null)
      : null
  const triageEligibility = eligibleForEngineTriage({
    enabled: triageFeatureEnabled,
    // Entitlement follows the sponsoring account, not the workspace row.
    workspacePlan: workspacePlan?.plan ?? "FREE",
    mode,
    billedCostUsd,
    costReconciled,
    maxBudgetUsd,
    triageCapUsd: env.LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD,
  })
  let triageTerminalReason: string | null = triageEligibility.reason
  let cacheOperations = {
    readCommands: 0,
    writeCommands: 0,
    bytesRead: 0,
    bytesWritten: 0,
  }

  if (
    targetType === "REPO" &&
    triageInput &&
    triageEligibility.eligible &&
    !hasGlobalScanTimeout()
  ) {
    const attempt = await attemptRepoTriageOverlay({
      scanId,
      workspaceId,
      targetId,
      triageInput,
      maxBudgetUsd: triageEligibility.maxBudgetUsd!,
      scanRuntimeBudgetMs,
      elapsedScanMs,
      hasGlobalScanTimeout,
      isScanCancelled,
      engineResult,
      aiSecuritySignals,
      updateAccounting,
    })
    aiSecuritySignals = attempt.aiSecuritySignals
    triageSnapshot = attempt.triageSnapshot
    triageTerminalReason = attempt.triageTerminalReason
    cacheOperations = attempt.cacheOperations
  }
  if (targetType === "REPO" && triageFeatureEnabled && (triageSnapshot || triageInput)) {
    await addScanEvent(
      scanId,
      "ai_security_triage",
      triageSnapshot?.status === "FAILED" || triageSnapshot?.status === "BUDGET_STOPPED"
        ? "warning"
        : "info",
      "AI-assisted triage overlay completed without changing deterministic findings",
      {
        status: triageSnapshot?.status ?? "DISABLED",
        terminalReason: triageSnapshot?.terminalReason ?? triageTerminalReason,
        resultCount: triageSnapshot?.resultCount ?? 0,
        cacheOperations,
      }
    ).catch((eventErr) =>
      logger.warn("Failed to persist AI-assisted triage terminal state", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    )
  }

  return {
    aiSecuritySignals,
    triageSnapshot,
    triageTerminalReason,
    budgetExceeded,
    billedCostUsd,
    costReconciled,
    ...(reconciliationReason ? { reconciliationReason } : {}),
  }
}
