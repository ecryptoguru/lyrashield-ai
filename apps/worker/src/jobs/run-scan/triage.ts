import { resolveAccountBilling } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { addScanEvent, runWithAccountContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { applyEngineTriageArtifact, type AISecuritySignal } from "@lyrashield/security"
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
  triageTerminalReason: string
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
}

export async function runEngineTriageOverlay(params: {
  scanId: string
  sponsorAccountId: string
  targetType: string
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
    sponsorAccountId,
    targetType,
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
  let triageTerminalReason = triageEligibility.reason

  if (
    targetType === "REPO" &&
    triageInput &&
    triageEligibility.eligible &&
    !hasGlobalScanTimeout()
  ) {
    try {
      const triageResult = await runEngineTriage({
        scanId,
        profile: resolveEngineProfile("STANDARD"),
        input: triageInput,
        maxBudgetUsd: triageEligibility.maxBudgetUsd!,
        timeoutMs: resolveScannerPhaseTimeoutMs(scanRuntimeBudgetMs, elapsedScanMs()),
        shouldCancel: async () => hasGlobalScanTimeout() || (await isScanCancelled()),
      })
      const artifact = triageResult.artifact
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
            triageSnapshot = {
              status: artifact.status,
              terminalReason: artifact.terminalReason,
              policyVersion: artifact.policyVersion,
              modelRoute: artifact.modelRoute,
              inputChecksum: artifact.inputChecksum,
              redactionReceipt: artifact.redactionReceipt.inputChecksum,
              resultCount: artifact.results.length,
            }
          }
        } else {
          if (!artifact) {
            triageTerminalReason = "TRIAGE_ARTIFACT_UNAVAILABLE"
          } else {
            triageSnapshot = {
              status: "FAILED",
              terminalReason: "TRIAGE_ACCOUNTING_UNAVAILABLE",
              policyVersion: artifact.policyVersion,
              modelRoute: artifact.modelRoute,
              inputChecksum: artifact.inputChecksum,
              redactionReceipt: artifact.redactionReceipt.inputChecksum,
              resultCount: 0,
            }
          }
        }
      } else if (artifact) {
        await updateAccounting()
        triageSnapshot = {
          status: artifact.status,
          terminalReason: artifact.terminalReason,
          policyVersion: artifact.policyVersion,
          modelRoute: artifact.modelRoute,
          inputChecksum: artifact.inputChecksum,
          redactionReceipt: artifact.redactionReceipt.inputChecksum,
          resultCount: 0,
        }
      } else {
        await updateAccounting()
      }
      triageTerminalReason = triageSnapshot?.terminalReason ?? "TRIAGE_ARTIFACT_UNAVAILABLE"
    } catch {
      // An additive overlay can never fail the deterministic scan.
      triageTerminalReason = "TRIAGE_COMMAND_FAILED"
    }
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
