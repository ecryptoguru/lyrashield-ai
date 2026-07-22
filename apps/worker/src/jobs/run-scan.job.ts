import type { Job } from "bullmq"
import { prisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import {
  buildVibeSecurityInstruction,
  summarizeVibeSecurityCoverage,
  checkInstructionSafety,
} from "@lyrashield/security"
import {
  updateScanStatus,
  addScanEvent,
  completeScanWithScore,
  qualifyReferralForWorkspace,
  type ScanStatus,
} from "@lyrashield/db"
import { runPreflight } from "./preflight.job"
import {
  runEngine,
  cleanupEngineWorkspace,
  interpretExitCode,
  resolveEngineProfile,
  resolveEngineTimeoutMs,
  type EngineRunResult,
} from "../engine/runner"
import { resolveScanBudgetUsd, type TargetType } from "../engine/command-builder"
import {
  calculateGpt56CostUsdFromBuckets,
  calculateGpt56CostUsdFromModelBuckets,
  GPT_56_PRICING_EFFECTIVE_DATE,
  GPT_56_PRICING_SOURCE,
  type Gpt56ModelUsageBuckets,
} from "../engine/gpt56-pricing"
import { persistFindings } from "../engine/finding-persister"
import {
  assertEvidenceStorageConfigured,
  EvidenceStorageConfigurationError,
} from "../engine/evidence-storage"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import {
  completeRetestsForScan,
  failTerminalRetestsForScan,
  markRetestsRunning,
  persistResultManifest,
} from "../engine/result-integrity"
import { notifyScanCompleted, notifyScanFailed, notifyCriticalFinding } from "../notifications"
import type { ScanJobData, ScanJobResult } from "../types"

export function extractActualCostUsd(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null
  for (const key of ["total_cost_usd", "cost_usd", "total_cost", "cost"]) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1_000_000) {
      return value
    }
  }
  return null
}

type UsageSummary = {
  requestCount: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteInputTokens: number | null
  outputTokens: number | null
  pricingBuckets: {
    standardInputTokens: number | null
    standardCachedInputTokens: number | null
    standardCacheWriteInputTokens: number | null
    standardOutputTokens: number | null
    longInputTokens: number | null
    longCachedInputTokens: number | null
    longCacheWriteInputTokens: number | null
    longOutputTokens: number | null
  } | null
  modelPricingBuckets: Gpt56ModelUsageBuckets[] | null
  engineReportedCostUsd: number | null
}

function usageCount(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key]
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null
}

function extractModelPricingBuckets(
  usage: Record<string, unknown>
): Gpt56ModelUsageBuckets[] | null {
  const rawBuckets = usage.model_usage_buckets
  if (!Array.isArray(rawBuckets) || rawBuckets.length === 0 || rawBuckets.length > 3) return null
  const result: Gpt56ModelUsageBuckets[] = []
  for (const rawBucket of rawBuckets) {
    if (typeof rawBucket !== "object" || rawBucket === null || Array.isArray(rawBucket)) return null
    const bucket = rawBucket as Record<string, unknown>
    const model = typeof bucket.model === "string" ? bucket.model.trim() : ""
    const values = {
      standardInputTokens: usageCount(bucket, "standard_input_tokens"),
      standardCachedInputTokens: usageCount(bucket, "standard_cached_input_tokens"),
      standardCacheWriteInputTokens: usageCount(bucket, "standard_cache_write_input_tokens"),
      standardOutputTokens: usageCount(bucket, "standard_output_tokens"),
      longInputTokens: usageCount(bucket, "long_input_tokens"),
      longCachedInputTokens: usageCount(bucket, "long_cached_input_tokens"),
      longCacheWriteInputTokens: usageCount(bucket, "long_cache_write_input_tokens"),
      longOutputTokens: usageCount(bucket, "long_output_tokens"),
    }
    if (!model || Object.values(values).some((value) => value === null)) return null
    result.push({ model, ...(values as Omit<Gpt56ModelUsageBuckets, "model">) })
  }
  return result
}

export function extractUsageSummary(usage: Record<string, unknown>): UsageSummary {
  const pricingBuckets = {
    standardInputTokens: usageCount(usage, "standard_input_tokens"),
    standardCachedInputTokens: usageCount(usage, "standard_cached_input_tokens"),
    standardCacheWriteInputTokens: usageCount(usage, "standard_cache_write_input_tokens"),
    standardOutputTokens: usageCount(usage, "standard_output_tokens"),
    longInputTokens: usageCount(usage, "long_input_tokens"),
    longCachedInputTokens: usageCount(usage, "long_cached_input_tokens"),
    longCacheWriteInputTokens: usageCount(usage, "long_cache_write_input_tokens"),
    longOutputTokens: usageCount(usage, "long_output_tokens"),
  }
  return {
    requestCount: usageCount(usage, "request_count"),
    inputTokens: usageCount(usage, "input_tokens"),
    cachedInputTokens: usageCount(usage, "cached_input_tokens"),
    cacheWriteInputTokens: usageCount(usage, "cache_write_input_tokens"),
    outputTokens: usageCount(usage, "output_tokens"),
    pricingBuckets: Object.values(pricingBuckets).every((value) => value !== null)
      ? pricingBuckets
      : null,
    modelPricingBuckets: extractModelPricingBuckets(usage),
    engineReportedCostUsd: extractActualCostUsd(usage),
  }
}

const MAX_SCAN_RUNTIME_MS = 30 * 60 * 1000

function resolveScanRuntimeBudgetMs(maxDurationMinutes: number | null | undefined): number {
  const configuredMaxMs =
    typeof maxDurationMinutes === "number" &&
    Number.isFinite(maxDurationMinutes) &&
    maxDurationMinutes > 0
      ? Math.floor(maxDurationMinutes * 60 * 1000)
      : MAX_SCAN_RUNTIME_MS

  return Math.min(configuredMaxMs, MAX_SCAN_RUNTIME_MS)
}

function resolveScannerPhaseTimeoutMs(engineTimeoutMs: number, globalScanBudgetMs: number): number {
  const totalRuntimeBudgetMs = Math.min(
    globalScanBudgetMs,
    env.SCANNER_PHASE_TIMEOUT_MS + engineTimeoutMs
  )
  const remainingForScannersMs = Math.max(0, totalRuntimeBudgetMs - engineTimeoutMs)

  if (remainingForScannersMs <= 0) {
    return 0
  }

  return Math.min(env.SCANNER_PHASE_TIMEOUT_MS, remainingForScannersMs)
}

function requireEngineModel(model: string | undefined): string {
  if (!model) {
    throw new Error(
      "A GPT-5.6 Sol, Terra, or Luna deployment must be configured for repository scans"
    )
  }
  return model
}

function timeoutErrorMessage(totalRuntimeMs: number): string {
  const minutes = Math.max(1, Math.ceil(totalRuntimeMs / 60_000))
  return `Scan exceeded the configured runtime limit of ${minutes} minute(s)`
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true

  const message = error.message.toLowerCase()
  return message.includes("timeout") || message.includes("timed out")
}

export async function persistEngineUsageCheckpoint(params: {
  scanId: string
  model: string
  maxBudgetUsd: number
  llmUsage?: Record<string, unknown>
  usageExpected: boolean
}): Promise<{
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
}> {
  const { scanId, model, maxBudgetUsd, llmUsage, usageExpected } = params
  if (!llmUsage) {
    if (usageExpected) {
      try {
        await addScanEvent(
          scanId,
          "llm_usage_unavailable",
          "warning",
          "AI usage counters were unavailable; billing reconciliation requires provider records"
        )
      } catch (eventErr) {
        logger.warn("Failed to persist llm_usage_unavailable event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }
    }
    return {
      budgetExceeded: false,
      billedCostUsd: null,
      costReconciled: !usageExpected,
      ...(usageExpected
        ? { reconciliationReason: "Per-request GPT-5.6 usage was unavailable" }
        : {}),
    }
  }

  const usage = extractUsageSummary(llmUsage)
  // Aggregate totals cannot prove whether an individual request crossed the
  // long-context boundary. Only complete per-request buckets are priceable.
  const rateCardCostUsd = usage.modelPricingBuckets
    ? calculateGpt56CostUsdFromModelBuckets(usage.modelPricingBuckets)
    : usage.pricingBuckets
      ? calculateGpt56CostUsdFromBuckets(model, usage.pricingBuckets)
      : null
  const costsMatch =
    rateCardCostUsd !== null &&
    (usage.engineReportedCostUsd === null ||
      Math.abs(rateCardCostUsd - usage.engineReportedCostUsd) < 0.000001)
  // Do not attach a money value to a scan unless the recorded provider total
  // agrees with the complete, per-request rate-card calculation. A completed
  // scan remains useful when accounting needs later operator reconciliation;
  // inventing a billable amount would not be.
  const billableCostUsd = costsMatch ? rateCardCostUsd : null
  const billedCostUsd = billableCostUsd === null ? null : Math.min(billableCostUsd, maxBudgetUsd)
  const costSource =
    rateCardCostUsd !== null && usage.engineReportedCostUsd !== null
      ? "rate_card_and_engine_reported"
      : rateCardCostUsd !== null
        ? "openai_rate_card"
        : usage.engineReportedCostUsd !== null
          ? "engine_reported_unreconciled"
          : "unavailable"
  const reconciliationStatus =
    rateCardCostUsd === null
      ? "unavailable"
      : usage.engineReportedCostUsd === null
        ? "rate_card_only"
        : costsMatch
          ? "matched"
          : "mismatch"

  try {
    await addScanEvent(scanId, "llm_usage", "info", "AI usage counters recorded", {
      ...usage,
      calculatedCostUsd: rateCardCostUsd,
      pricingMethod: usage.modelPricingBuckets
        ? "per_request_model_buckets"
        : usage.pricingBuckets
          ? "per_request_buckets"
          : "unavailable",
      billedCostUsd,
      costSource,
      reconciliationStatus,
      ...(rateCardCostUsd !== null
        ? {
            pricingEffectiveDate: GPT_56_PRICING_EFFECTIVE_DATE,
            pricingSource: GPT_56_PRICING_SOURCE,
          }
        : {}),
    })
  } catch (eventErr) {
    logger.warn("Failed to persist llm_usage event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      providerCostUsd:
        usage.engineReportedCostUsd === null ? null : usage.engineReportedCostUsd.toFixed(6),
      billedCostUsd: billedCostUsd === null ? null : billedCostUsd.toFixed(6),
      actualCostCents: billedCostUsd === null ? null : Math.round(billedCostUsd * 100),
      llmRequestCount: usage.requestCount,
      llmInputTokens: usage.inputTokens,
      llmCachedInputTokens: usage.cachedInputTokens,
      llmOutputTokens: usage.outputTokens,
    },
  })

  const budgetExceeded = billableCostUsd !== null && billableCostUsd > maxBudgetUsd
  if (budgetExceeded) {
    logger.warn("Engine reported spend above worker budget cap", {
      scanId,
      billableCostUsd,
      maxBudgetUsd,
    })
    try {
      await addScanEvent(scanId, "budget_exceeded", "error", "Protected run limit reached", {
        billableCostUsd,
        billedCostUsd,
        maxBudgetUsd,
      })
    } catch (eventErr) {
      logger.warn("Failed to persist budget_exceeded event", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    }
    await prisma.scan.update({
      where: { id: scanId },
      data: {
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: "Protected run limit reached",
        actualCostCents: Math.round(billedCostUsd! * 100),
      },
    })
  }

  return {
    budgetExceeded,
    billedCostUsd,
    costReconciled: !usageExpected || costsMatch,
    ...(!usageExpected || costsMatch
      ? {}
      : {
          reconciliationReason:
            rateCardCostUsd === null
              ? "Complete per-request GPT-5.6 usage buckets were unavailable"
              : "Engine-reported cost did not match the GPT-5.6 rate-card calculation",
        }),
  }
}

export async function processScanJob(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
  const { scanId, workspaceId, targetId, goal, mode, policyId } = job.data
  const log = logger

  log.info("Processing scan job", { scanId, targetId, mode, jobId: job.id })

  // Wrap the entire job in workspace context so the Prisma client extension's
  // auto-scoping safety net is active for all DB queries. Without this, a
  // missed manual workspaceId filter could leak cross-tenant data.
  return runWithWorkspaceContext(workspaceId, async () => {
    let globalScanTimeoutReached = false
    let scanRuntimeBudgetMs = MAX_SCAN_RUNTIME_MS
    let billablePhaseStarted = false
    try {
      // A manifest is the immutable checkpoint after findings and retests have
      // been persisted. If an infrastructure error interrupted only the final
      // score transition, resume that transition without replaying a billable
      // scan or comparing a fresh result against the original manifest.
      const pendingFinalization = await prisma.scan.findUnique({
        where: { id: scanId },
        select: {
          status: true,
          summary: true,
          errorCategory: true,
          errorMessage: true,
          actualCostCents: true,
          resultManifest: { select: { id: true } },
          events: {
            where: { stage: "billable_boundary" },
            select: { id: true },
            take: 1,
          },
        },
      })
      if (pendingFinalization?.status === "VERIFYING" && pendingFinalization.resultManifest) {
        if (pendingFinalization.errorCategory === "BUDGET_EXCEEDED") {
          await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: pendingFinalization.errorMessage ?? "Protected run limit reached",
            ...(pendingFinalization.actualCostCents !== null
              ? { actualCostCents: pendingFinalization.actualCostCents }
              : {}),
          })
          return {
            status: "failed",
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: "Protected run limit reached",
          }
        }
        await completeScanWithScore(scanId, pendingFinalization.summary)
        try {
          await qualifyReferralForWorkspace(workspaceId)
        } catch (referralError) {
          log.warn("Failed to qualify referral after resumed scan completion", {
            scanId,
            error: referralError instanceof Error ? referralError.message : String(referralError),
          })
        }
        return { status: "completed", summary: pendingFinalization.summary ?? "Scan completed" }
      }
      if (
        ["RUNNING", "VERIFYING"].includes(pendingFinalization?.status ?? "") &&
        pendingFinalization?.events?.length
      ) {
        const interruptedMessage =
          "Provider-billable analysis was interrupted and was not replayed automatically"
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "BILLABLE_PHASE_INTERRUPTED",
          errorMessage: interruptedMessage,
        })
        return {
          status: "failed",
          errorCategory: "BILLABLE_PHASE_INTERRUPTED",
          errorMessage: interruptedMessage,
        }
      }

      // 1. Preflight checks
      await updateScanStatus(scanId, "PREFLIGHT" as ScanStatus)
      const preflight = await runPreflight(scanId, targetId)

      if (!preflight.passed) {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: preflight.errorCategory,
          errorMessage: preflight.errorMessage,
        })
        return {
          status: "failed",
          errorCategory: preflight.errorCategory,
          errorMessage: preflight.errorMessage,
        }
      }

      // 2. Fetch target details for the engine
      const target = await prisma.target.findFirst({
        where: { id: targetId, deletedAt: null },
      })

      if (!target) {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "TARGET_NOT_FOUND",
          errorMessage: "Target disappeared between preflight and execution",
        })
        return {
          status: "failed",
          errorCategory: "TARGET_NOT_FOUND",
          errorMessage: "Target not found",
        }
      }

      // Reject prompt-injection patterns in user-controlled fields before they
      // reach the engine prompt. This is fail-fast, before any provider spend.
      const goalSafety = checkInstructionSafety(goal)
      const targetNameSafety = checkInstructionSafety(target.name ?? "")
      if (!goalSafety.safe || !targetNameSafety.safe) {
        const patterns = [
          ...new Set([...goalSafety.detectedPatterns, ...targetNameSafety.detectedPatterns]),
        ]
        const reason = `Prompt injection risk detected in scan input: ${patterns.join(", ")}`
        log.warn("Scan rejected due to prompt injection risk", {
          scanId,
          patterns,
          goalSafe: goalSafety.safe,
          targetNameSafe: targetNameSafety.safe,
        })
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "PROMPT_INJECTION",
          errorMessage: reason,
        })
        return { status: "failed", errorCategory: "PROMPT_INJECTION", errorMessage: reason }
      }

      // Evidence is part of the result contract. Refuse before provider work
      // when it cannot be retained durably.
      assertEvidenceStorageConfigured()

      // 3. Run the scan engine
      await updateScanStatus(scanId, "RUNNING" as ScanStatus)
      await markRetestsRunning(scanId)

      const policy = policyId
        ? await prisma.policy.findFirst({
            where: { id: policyId, workspaceId, deletedAt: null },
            select: { maxBudgetUsd: true, maxDurationMinutes: true },
          })
        : null
      const policyMaxBudgetUsd = policy?.maxBudgetUsd?.toNumber()
      const scanStartedAtMs = Date.now()
      scanRuntimeBudgetMs = resolveScanRuntimeBudgetMs(policy?.maxDurationMinutes)
      const maxBudgetUsd = resolveScanBudgetUsd(mode, policyMaxBudgetUsd)
      const engineTimeoutMs = resolveEngineTimeoutMs(policy?.maxDurationMinutes)
      const engineProfile = resolveEngineProfile(mode)
      const engineModel =
        target.type === "REPO" ? requireEngineModel(engineProfile.model) : engineProfile.model
      const budgetSource =
        typeof policyMaxBudgetUsd === "number" &&
        Number.isFinite(policyMaxBudgetUsd) &&
        policyMaxBudgetUsd > 0
          ? "policy"
          : "mode_default"

      try {
        await addScanEvent(scanId, "budget_cap", "info", "Protected run limit enabled", {
          maxBudgetUsd,
          source: budgetSource,
        })
      } catch (eventErr) {
        log.warn("Failed to persist budget_cap event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      if (target.type === "REPO") {
        // Once the external engine begins, an automatic BullMQ replay could
        // spend twice for the same scan. Preflight remains retryable; the
        // billable phase is terminal and any rerun requires a fresh scan.
        await addScanEvent(
          scanId,
          "billable_boundary",
          "info",
          "Automatic retries disabled before provider-billable analysis",
          { retryPolicy: "fresh_scan_required" }
        )
        billablePhaseStarted = true
      }

      const hasGlobalScanTimeout = (): boolean => {
        if (Date.now() - scanStartedAtMs >= scanRuntimeBudgetMs) {
          globalScanTimeoutReached = true
          return true
        }
        return false
      }

      const isCancelledOrTimedOut = async () => {
        if (hasGlobalScanTimeout()) return true
        const current = await prisma.scan.findUnique({
          where: { id: scanId },
          select: { status: true },
        })
        return current?.status === "CANCELLED"
      }

      const failWithScanTimeout = async (timeoutMessage: string) => {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "TIMEOUT",
          errorMessage: timeoutMessage,
        })
        try {
          await notifyScanFailed(workspaceId, scanId, timeoutMessage)
        } catch (notificationError) {
          log.warn("Failed to send scan timeout notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
      }

      const engineResult: EngineRunResult =
        target.type === "REPO"
          ? await runEngine(
              {
                scanId,
                goal,
                mode,
                target: {
                  id: target.id,
                  type: target.type as TargetType,
                  url: target.url,
                  repoFullName: target.repoFullName,
                  name: target.name,
                },
                instruction: buildVibeSecurityInstruction(goal),
                maxBudgetUsd,
              },
              scanId,
              resolveEngineTimeoutMs(policy?.maxDurationMinutes),
              async () => {
                const current = await prisma.scan.findUnique({
                  where: { id: scanId },
                  select: { status: true },
                })
                return current?.status === "CANCELLED"
              }
            )
          : {
              exitCode: 0,
              cancelled: false,
              timedOut: false,
              sourceCheckoutPath: null,
              output: {
                vulnerabilities: [],
                runRecord: null,
                findingCount: 0,
                summary: "URL target scanned through the pinned deterministic URL scanner.",
                findingsComplete: true,
              },
            }

      if (globalScanTimeoutReached) {
        const timeoutMessage = timeoutErrorMessage(scanRuntimeBudgetMs)
        await failWithScanTimeout(timeoutMessage)
        return { status: "failed", errorCategory: "TIMEOUT", errorMessage: timeoutMessage }
      }

      if (target.type !== "REPO") {
        await addScanEvent(
          scanId,
          "engine_skipped",
          "info",
          "External engine skipped for URL targets until it supports pinned transport",
          { targetType: target.type }
        )
      }

      // Persist usage before deterministic scanners or finding persistence can
      // fail, so provider spend is never lost behind a downstream error.
      const { budgetExceeded, billedCostUsd } = await persistEngineUsageCheckpoint({
        scanId,
        model: engineModel ?? "",
        maxBudgetUsd,
        llmUsage: engineResult.output.runRecord?.llm_usage,
        usageExpected: target.type === "REPO",
      })
      const runRecord = engineResult.output.runRecord
      const exitInterpretation = interpretExitCode(engineResult.exitCode)
      const engineExecution =
        target.type === "REPO"
          ? {
              model: requireEngineModel(engineModel),
              reasoningEffort: engineProfile.reasoningEffort,
              image: env.LYRASHIELD_IMAGE || null,
              ...(runRecord?.engine_version ? { engineVersion: runRecord.engine_version } : {}),
              ...(runRecord?.prompt_bundle_hash
                ? { promptBundleHash: runRecord.prompt_bundle_hash }
                : {}),
              ...(runRecord?.max_output_tokens
                ? { maxOutputTokens: runRecord.max_output_tokens }
                : {}),
              ...(runRecord?.max_agents ? { maxAgents: runRecord.max_agents } : {}),
            }
          : undefined

      if (engineResult.cancelled) {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      if (engineResult.timedOut) {
        const timeoutMessage = "Scan engine timed out before completing"
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "TIMEOUT",
          errorMessage: timeoutMessage,
        })
        try {
          await notifyScanFailed(workspaceId, scanId, timeoutMessage)
        } catch (notificationError) {
          log.warn("Failed to send scan timeout notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return { status: "failed", errorCategory: "TIMEOUT", errorMessage: timeoutMessage }
      }

      // Capture the engine's real terminal cause, but do not return early.
      // Deterministic scanners can still provide value from a partial engine run
      // (for example, when the engine cloned the repository but stopped for a
      // budget or model error). Usage is checkpointed above for reconciliation.
      let engineTerminalError: {
        status: ScanStatus
        errorCategory: string
        errorMessage: string
      } | null = null

      if (target.type === "REPO" && exitInterpretation.status === "FAILED") {
        const stoppedForBudget = exitInterpretation.category === "BUDGET_EXCEEDED"
        engineTerminalError = {
          status: (stoppedForBudget ? "STOPPED_BUDGET" : "FAILED") as ScanStatus,
          errorCategory: exitInterpretation.category,
          errorMessage: exitInterpretation.message,
        }
        try {
          await addScanEvent(
            scanId,
            "engine_terminal",
            stoppedForBudget ? "error" : "warning",
            `Engine stopped (${exitInterpretation.category}); continuing with deterministic scanners`,
            {
              exitCode: engineResult.exitCode,
              errorCategory: exitInterpretation.category,
            }
          )
        } catch (eventErr) {
          log.warn("Failed to persist engine_terminal event", {
            scanId,
            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
          })
        }
      } else if (
        target.type === "REPO" &&
        (!engineResult.output.findingsComplete ||
          !runRecord ||
          runRecord.run_id !== scanId ||
          runRecord.run_name !== scanId ||
          runRecord.status !== "completed")
      ) {
        const stoppedForBudget = runRecord?.terminal_reason === "budget_exceeded"
        const errorCategory = stoppedForBudget ? "BUDGET_EXCEEDED" : "ENGINE_INCOMPLETE"
        const errorMessage = stoppedForBudget
          ? "Protected run limit reached"
          : "Engine did not produce a completed, valid result receipt"
        engineTerminalError = {
          status: (stoppedForBudget ? "STOPPED_BUDGET" : "FAILED") as ScanStatus,
          errorCategory,
          errorMessage,
        }
        try {
          await addScanEvent(
            scanId,
            "engine_incomplete",
            "warning",
            `Engine result incomplete; continuing with deterministic scanners`,
            { errorCategory }
          )
        } catch (eventErr) {
          log.warn("Failed to persist engine_incomplete event", {
            scanId,
            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
          })
        }
      }

      // 4. Run scanner orchestrator (SCA + secrets + normalization)
      await updateScanStatus(scanId, "VERIFYING" as ScanStatus)
      const scannerPhaseTimeoutMs = resolveScannerPhaseTimeoutMs(
        engineTimeoutMs,
        scanRuntimeBudgetMs
      )

      const orchestratorResult = await runScannerOrchestrator({
        scanId,
        workspaceId,
        targetId,
        target: {
          id: target.id,
          type: target.type as TargetType,
          url: target.url,
          repoFullName: target.repoFullName,
          name: target.name,
        },
        goal,
        mode,
        engineFindings: engineResult.output.vulnerabilities,
        workspaceDir: engineResult.sourceCheckoutPath ?? undefined,
        scannerPhaseTimeoutMs,
        isCancelled: isCancelledOrTimedOut,
      })

      try {
        await addScanEvent(
          scanId,
          "scanners_complete",
          "info",
          `Scan phases complete: engine=${orchestratorResult.engineFindings.length}, sca=${orchestratorResult.scaFindings.length}, secrets=${orchestratorResult.secretsFindings.length}, url=${orchestratorResult.urlFindings.length}, agent_config=${orchestratorResult.agentConfigFindings.length}, false_positives_filtered=${orchestratorResult.filteredFalsePositives}`,
          {
            engine: orchestratorResult.engineFindings.length,
            sca: orchestratorResult.scaFindings.length,
            secrets: orchestratorResult.secretsFindings.length,
            url: orchestratorResult.urlFindings.length,
            agentConfig: orchestratorResult.agentConfigFindings.length,
            falsePositivesFiltered: orchestratorResult.filteredFalsePositives,
            stats: orchestratorResult.stats,
          }
        )
      } catch (eventErr) {
        log.warn("Failed to persist scanners_complete event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      const coverage = summarizeVibeSecurityCoverage(orchestratorResult.allFindings)
      try {
        await addScanEvent(
          scanId,
          "coverage_contract",
          "info",
          `Vibe Security 50: ${coverage.machineControlsRequested} machine-testable controls requested where applicable; ${coverage.matchedControlRanks.length} produced findings; ${coverage.evidenceControlsRequired} require deployment or human evidence`,
          coverage
        )
      } catch (eventErr) {
        log.warn("Failed to persist coverage_contract event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      // 5. Persist normalized findings
      const persistedFindings = await persistFindings({
        scanId,
        workspaceId,
        targetId,
        vulnerabilities: orchestratorResult.allFindings,
      })

      const newFindings = persistedFindings.filter((f) => f.isNew).length
      const dupFindings = persistedFindings.length - newFindings

      try {
        await addScanEvent(
          scanId,
          "findings_persisted",
          "info",
          `Persisted ${persistedFindings.length} finding(s): ${newFindings} new, ${dupFindings} duplicate`,
          {
            total: persistedFindings.length,
            new: newFindings,
            duplicate: dupFindings,
          }
        )
      } catch (eventErr) {
        log.warn("Failed to persist findings_persisted event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      await completeRetestsForScan({
        scanId,
        workspaceId,
        persistedFindingIds: persistedFindings.map((finding) => finding.id),
        coverageIssues: orchestratorResult.coverageIssues,
      })

      // Persist the result manifest for every outcome, including a failed or
      // incomplete engine, so coverage receipts are always available.
      await prisma.scan.update({
        where: { id: scanId },
        data: { summary: engineResult.output.summary },
      })
      await persistResultManifest({
        scanId,
        target: {
          id: target.id,
          type: target.type,
          repoFullName: target.repoFullName,
          branch: target.branch,
          url: target.url,
        },
        sourceCheckoutAvailable: Boolean(engineResult.sourceCheckoutPath),
        engineFindingCount: orchestratorResult.engineFindings.length,
        coverageIssues: orchestratorResult.coverageIssues,
        matchedControlRanks: coverage.matchedControlRanks,
        engineExecution,
      })

      if (engineTerminalError) {
        await updateScanStatus(scanId, engineTerminalError.status, {
          errorCategory: engineTerminalError.errorCategory,
          errorMessage: engineTerminalError.errorMessage,
          ...(billedCostUsd !== null ? { actualCostCents: Math.round(billedCostUsd * 100) } : {}),
        })
        try {
          await notifyScanFailed(workspaceId, scanId, engineTerminalError.errorMessage)
        } catch (notificationError) {
          log.warn("Failed to send scan failure notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return {
          status: "failed",
          errorCategory: engineTerminalError.errorCategory,
          errorMessage: engineTerminalError.errorMessage,
        }
      }

      if (budgetExceeded) {
        await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
          actualCostCents: Math.round(billedCostUsd! * 100),
        })
        return {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
        }
      }
      // Retests may validate a pending fix and change the target's scoreable
      // state. Freeze the score only after those outcomes are persisted.
      await completeScanWithScore(scanId, engineResult.output.summary)
      try {
        await qualifyReferralForWorkspace(workspaceId)
      } catch (referralError) {
        // Referral accounting is downstream of scan completion. An outage here
        // must not retry or reverse a scan that has already completed atomically.
        log.warn("Failed to qualify referral after scan completion", {
          scanId,
          error: referralError instanceof Error ? referralError.message : String(referralError),
        })
      }

      log.info("Scan job completed", {
        scanId,
        targetId,
        exitCode: engineResult.exitCode,
        findings: persistedFindings.length,
        newFindings,
      })

      try {
        const criticalFindings = persistedFindings.filter((f) => f.severity === "CRITICAL")
        const notifications = await Promise.allSettled([
          notifyScanCompleted(
            workspaceId,
            scanId,
            engineResult.output.summary,
            persistedFindings.length
          ),
          ...criticalFindings.map((finding) =>
            notifyCriticalFinding(workspaceId, finding.id, finding.title, target.name)
          ),
        ])
        const failedNotifications = notifications.filter(
          (notification): notification is PromiseRejectedResult =>
            notification.status === "rejected"
        )
        if (failedNotifications.length > 0) {
          log.warn("Some scan completion notifications failed", {
            scanId,
            failures: failedNotifications.map((notification) =>
              notification.reason instanceof Error
                ? notification.reason.message
                : String(notification.reason)
            ),
          })
        }
      } catch (notificationError) {
        // A notification provider outage must not retry or reverse an already-completed scan.
        log.warn("Failed to send scan completion notification", {
          scanId,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        })
      }

      return {
        status: "completed",
        summary: engineResult.output.summary,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCategory = error instanceof Error ? error.name : "UNKNOWN"
      const finalErrorCategory =
        globalScanTimeoutReached || isTimeoutError(error) ? "TIMEOUT" : errorCategory
      const finalErrorMessage =
        finalErrorCategory === "TIMEOUT" &&
        !errorMessage.includes("Scan exceeded the configured runtime limit")
          ? timeoutErrorMessage(scanRuntimeBudgetMs)
          : errorMessage

      log.error("Scan job failed", { scanId, error: errorMessage })

      const currentScan = await prisma.scan
        .findUnique({
          where: { id: scanId },
          select: { status: true },
        })
        .catch(() => null)
      if (currentScan?.status === "CANCELLED") {
        if (globalScanTimeoutReached) {
          return {
            status: "failed",
            errorCategory: "TIMEOUT",
            errorMessage: timeoutErrorMessage(scanRuntimeBudgetMs),
          }
        }
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      const maxAttempts = job.opts?.attempts ?? 1
      const isTerminalPrerequisiteFailure = error instanceof EvidenceStorageConfigurationError
      if (
        !billablePhaseStarted &&
        !isTerminalPrerequisiteFailure &&
        (job.attemptsMade ?? 0) + 1 < maxAttempts
      ) {
        await prisma.scan.updateMany({
          where: {
            id: scanId,
            status: { in: ["PREFLIGHT", "RUNNING", "VERIFYING"] },
          },
          data: { status: "QUEUED" },
        })
        log.warn("Scan job failed and will be retried", {
          scanId,
          attempt: (job.attemptsMade ?? 0) + 1,
          maxAttempts,
        })
        throw error
      }

      try {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: finalErrorCategory,
          errorMessage: finalErrorMessage,
        })
      } catch (updateErr) {
        log.error("Failed to update scan status on error", {
          scanId,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        })
      }

      return {
        status: "failed",
        errorCategory: finalErrorCategory,
        errorMessage: finalErrorMessage,
      }
    } finally {
      try {
        await failTerminalRetestsForScan(scanId)
      } catch (retestError) {
        log.warn("Failed to finalize retest state", {
          scanId,
          error: retestError instanceof Error ? retestError.message : String(retestError),
        })
      }
      try {
        await cleanupEngineWorkspace(`lyrashield_runs/${scanId}`, scanId)
      } catch {
        // Non-fatal — workspace cleanup is best-effort
      }
    }
  }) // end runWithWorkspaceContext
}
