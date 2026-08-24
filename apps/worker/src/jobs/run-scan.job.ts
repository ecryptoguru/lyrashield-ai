import type { Job } from "bullmq"
import { prisma, runWithWorkspaceContext, getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { recordAgentMinutes, getUsageBalance, enterGrace, debitOverage } from "@lyrashield/billing"
import {
  buildVibeSecurityInstruction,
  summarizeVibeSecurityCoverage,
  checkInstructionSafety,
  containsPromptInjection,
  applyEngineTriageArtifact,
} from "@lyrashield/security"
import {
  updateScanStatus,
  addScanEvent,
  completeScanWithScore,
  createAiSecurityScoreSnapshot,
  qualifyReferralForWorkspace,
  withScanFinalizationClaim,
  type ScanStatus,
} from "@lyrashield/db"
import { resolveScanProfile, resolveTargetScanMode, type UrlScanProfile } from "@lyrashield/types"
import { runPreflight } from "./preflight.job"
import {
  runEngine,
  cleanupEngineWorkspace,
  interpretExitCode,
  resolveEngineProfile,
  runEngineTriage,
  type EngineRunResult,
} from "../engine/runner"
import { mergeLlmUsage } from "../engine/output-parser"
import { buildEngineTriageInput, eligibleForEngineTriage } from "../engine/ai-security-triage"
import { resolveScanBudgetUsd, type TargetType } from "../engine/command-builder"
import {
  calculateGpt56CostUsd,
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
import { ScanJobDataSchema, type ScanJobData, type ScanJobResult } from "../types"

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
  singleModel: string | null
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
  const modelPricingBuckets = extractModelPricingBuckets(usage)
  const bucketModels = modelPricingBuckets
    ? [...new Set(modelPricingBuckets.map((b) => b.model))]
    : []
  const rootModel = typeof usage["model"] === "string" ? (usage["model"] as string) : null
  const singleModel = bucketModels.length === 1 ? bucketModels[0]! : rootModel

  return {
    requestCount: usageCount(usage, "request_count"),
    inputTokens: usageCount(usage, "input_tokens"),
    cachedInputTokens: usageCount(usage, "cached_input_tokens"),
    cacheWriteInputTokens: usageCount(usage, "cache_write_input_tokens"),
    outputTokens: usageCount(usage, "output_tokens"),
    pricingBuckets: Object.values(pricingBuckets).every((value) => value !== null)
      ? pricingBuckets
      : null,
    modelPricingBuckets,
    singleModel,
    engineReportedCostUsd: extractActualCostUsd(usage),
  }
}

const MAX_SCAN_RUNTIME_MS = 30 * 60 * 1000

export function resolveScanRuntimeBudgetMs(
  mode: ScanJobData["mode"],
  maxDurationMinutes: number | null | undefined,
  targetType = "REPO"
): number {
  let modeMaxMs = MAX_SCAN_RUNTIME_MS
  try {
    modeMaxMs = resolveScanProfile({ targetType, mode }).maxDurationMinutes * 60 * 1000
  } catch {
    // A historical invalid row must not turn a worker retry into an unbounded run.
    modeMaxMs = MAX_SCAN_RUNTIME_MS
  }
  const configuredMaxMs =
    typeof maxDurationMinutes === "number" &&
    Number.isFinite(maxDurationMinutes) &&
    maxDurationMinutes > 0
      ? Math.floor(maxDurationMinutes * 60 * 1000)
      : modeMaxMs

  return Math.min(configuredMaxMs, modeMaxMs)
}

export function resolveScannerPhaseTimeoutMs(
  globalScanBudgetMs: number,
  elapsedMs: number
): number {
  // ponytail: spend only the wall-clock time the engine actually used.
  return Math.max(0, Math.min(env.SCANNER_PHASE_TIMEOUT_MS, globalScanBudgetMs - elapsedMs))
}

function requireEngineModel(model: string | undefined): string {
  if (!model) {
    throw new Error("A GPT-5.6 Terra or Luna deployment must be configured for repository scans")
  }
  return model
}

function timeoutErrorMessage(totalRuntimeMs: number): string {
  const minutes = Math.max(1, Math.ceil(totalRuntimeMs / 60_000))
  return `Scan exceeded the configured runtime limit of ${minutes} minute(s)`
}

function imageDigest(image: string | undefined): string | undefined {
  return image?.match(/@?(sha256:[a-f0-9]{64})$/i)?.[1]?.toLowerCase()
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true

  const message = error.message.toLowerCase()
  return message.includes("timeout") || message.includes("timed out")
}

export async function persistEngineUsageCheckpoint(params: {
  scanId: string
  maxBudgetUsd: number
  llmUsage?: Record<string, unknown>
  webSearchCostUsd?: number
  usageExpected: boolean
}): Promise<{
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
}> {
  const { scanId, maxBudgetUsd, llmUsage, webSearchCostUsd = 0, usageExpected } = params
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
  // Per-request buckets are the only way to price mixed-context scans
  // accurately. When they are unavailable, fall back to aggregate counters
  // only if the usage payload names a single model, so we do not misprice a
  // Terra/Luna mix at the configured model rate.
  const aggregateCostUsd =
    usage.inputTokens !== null &&
    usage.cachedInputTokens !== null &&
    usage.outputTokens !== null &&
    usage.singleModel
      ? calculateGpt56CostUsd(usage.singleModel, {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          outputTokens: usage.outputTokens,
        })
      : null

  let pricingMethod: string
  let modelMixUnpriceable = false
  let rateCardCostUsd: number | null = null

  if (usage.modelPricingBuckets) {
    const tokenCostUsd = calculateGpt56CostUsdFromModelBuckets(usage.modelPricingBuckets)
    rateCardCostUsd = tokenCostUsd === null ? null : tokenCostUsd + webSearchCostUsd
    pricingMethod = "per_request_model_buckets"
  } else if (usage.pricingBuckets) {
    if (usage.singleModel) {
      const tokenCostUsd = calculateGpt56CostUsdFromBuckets(usage.singleModel, usage.pricingBuckets)
      rateCardCostUsd = tokenCostUsd === null ? null : tokenCostUsd + webSearchCostUsd
      pricingMethod = "per_request_buckets"
    } else {
      modelMixUnpriceable = true
      pricingMethod = "model_mix_unpriceable"
    }
  } else if (aggregateCostUsd !== null) {
    rateCardCostUsd = aggregateCostUsd + webSearchCostUsd
    pricingMethod = "aggregate_tokens"
  } else {
    pricingMethod = "unavailable"
  }

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
        ? "azure_rate_card"
        : usage.engineReportedCostUsd !== null
          ? "engine_reported_unreconciled"
          : "unavailable"
  const reconciliationStatus = modelMixUnpriceable
    ? "model_mix_unpriceable"
    : rateCardCostUsd === null
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
      pricingMethod,
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
  const log = logger

  // Prompt-injection checks happen before any schema trust: an attacker could
  // place arbitrary text in the queue payload and the goal field is later used
  // to build the engine instruction.
  if (typeof job.data?.goal === "string" && containsPromptInjection(job.data.goal)) {
    log.warn("Scan job goal contains prompt-injection patterns", { jobId: job.id })
    return {
      status: "failed",
      errorCategory: "PROMPT_INJECTION",
      errorMessage: "Scan goal contains disallowed instruction patterns",
    }
  }

  // Validate and coerce the untrusted BullMQ payload before trusting any field.
  const parseResult = ScanJobDataSchema.safeParse(job.data)
  if (!parseResult.success) {
    log.warn("Scan job payload failed schema validation", {
      jobId: job.id,
      errors: parseResult.error.issues.map((i) => i.message),
    })
    return {
      status: "failed",
      errorCategory: "INVALID_JOB",
      errorMessage: parseResult.error.message,
    }
  }

  const {
    scanId,
    workspaceId: claimedWorkspaceId,
    targetId,
    goal,
    mode,
    policyId,
  } = parseResult.data

  log.info("Processing scan job", { scanId, targetId, mode, jobId: job.id })

  // Do not trust the workspaceId from the queue payload. Load the scan record
  // with a privileged client and verify the claimed tenant matches the stored
  // tenant; otherwise a forged job could read or mutate another workspace.
  let scanRecord
  try {
    scanRecord = await getSystemPrisma().scan.findUnique({
      where: { id: scanId },
      select: { id: true, workspaceId: true, targetId: true },
    })
  } catch (err) {
    throw new Error(
      `Failed to verify scan ownership: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (
    !scanRecord ||
    scanRecord.workspaceId !== claimedWorkspaceId ||
    scanRecord.targetId !== targetId
  ) {
    try {
      await updateScanStatus(scanId, "FAILED" as ScanStatus, {
        errorCategory: "INVALID_JOB",
        errorMessage: "Scan job does not match the stored scan record",
      })
    } catch (statusErr) {
      log.warn("Failed to mark invalid scan job as failed", {
        scanId,
        error: statusErr instanceof Error ? statusErr.message : String(statusErr),
      })
    }
    return {
      status: "failed",
      errorCategory: "INVALID_JOB",
      errorMessage: "Scan job does not match the stored scan record",
    }
  }
  const workspaceId = scanRecord.workspaceId

  // Wrap the entire job in workspace context so the Prisma client extension's
  // auto-scoping safety net is active for all DB queries. Without this, a
  // missed manual workspaceId filter could leak cross-tenant data.
  return runWithWorkspaceContext(workspaceId, async () => {
    let globalScanTimeoutReached = false
    let scanRuntimeBudgetMs = MAX_SCAN_RUNTIME_MS
    let billablePhaseStarted = false
    let urlProfile: UrlScanProfile | undefined
    let engineProfile: ReturnType<typeof resolveEngineProfile> | undefined
    let engineModel: string | undefined
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
        // The manifest is persisted before retest finalization in the normal
        // path, so a crash between the two must resume pending retests from the
        // stored receipt evidence before scoring; otherwise retest validation
        // would be skipped silently. Nothing here invokes the engine or reruns
        // scanners, so billable work is never replayed.
        await completeRetestsForScan({ scanId, workspaceId })
        await completeScanWithScore(scanId, workspaceId, pendingFinalization.summary)
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
        select: {
          id: true,
          type: true,
          name: true,
          url: true,
          repoFullName: true,
          branch: true,
          apiSpecUrl: true,
        },
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

      if (target.type === "WEB_APP" || target.type === "API") {
        const resolved = resolveTargetScanMode({
          targetType: target.type,
          mode,
          hasApiSpec: Boolean(target.apiSpecUrl),
        })
        if (!resolved.ok) {
          await updateScanStatus(scanId, "FAILED" as ScanStatus, {
            errorCategory: resolved.code,
            errorMessage: resolved.reason,
          })
          return {
            status: "failed",
            errorCategory: resolved.code,
            errorMessage: resolved.reason,
          }
        }
        urlProfile = resolved.profile ?? undefined
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
      scanRuntimeBudgetMs = resolveScanRuntimeBudgetMs(
        mode,
        policy?.maxDurationMinutes,
        target.type
      )

      const hasGlobalScanTimeout = (): boolean => {
        if (Date.now() - scanStartedAtMs >= scanRuntimeBudgetMs) {
          globalScanTimeoutReached = true
          return true
        }
        return false
      }

      // Cancellation is polled frequently (the scanner orchestrator checks on a
      // ~1s interval), so memoize the CANCELLED lookup for a short window to
      // avoid a DB query every second per active scan. A cancel is still
      // detected within CANCEL_CACHE_MS; correctness only requires timely
      // detection, not instantaneous.
      const CANCEL_CACHE_MS = 2000
      let cancelCacheAt = 0
      let cancelCacheValue = false
      const isScanCancelled = async (force = false): Promise<boolean> => {
        const now = Date.now()
        if (!force && now - cancelCacheAt < CANCEL_CACHE_MS) return cancelCacheValue
        const current = await prisma.scan.findUnique({
          where: { id: scanId },
          select: { status: true },
        })
        cancelCacheValue = current?.status === "CANCELLED"
        cancelCacheAt = now
        return cancelCacheValue
      }

      const isCancelledOrTimedOut = async () => {
        if (target.type !== "REPO" && hasGlobalScanTimeout()) return true
        return isScanCancelled()
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

      let engineResult: EngineRunResult
      let maxBudgetUsd = 0

      if (target.type === "REPO") {
        maxBudgetUsd = resolveScanBudgetUsd(mode, policyMaxBudgetUsd)
        if (maxBudgetUsd <= 0) {
          const errorMessage = "Protected run limit is zero"
          log.warn("Scan rejected: zero budget", { scanId, workspaceId, policyMaxBudgetUsd })
          try {
            await addScanEvent(scanId, "budget_exceeded", "error", errorMessage, {
              maxBudgetUsd,
              policyMaxBudgetUsd,
            })
          } catch (eventErr) {
            log.warn("Failed to persist budget_exceeded event", {
              scanId,
              error: eventErr instanceof Error ? eventErr.message : String(eventErr),
            })
          }
          return {
            status: "failed",
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage,
          }
        }

        engineProfile = resolveEngineProfile(mode)
        engineModel = requireEngineModel(engineProfile.model)
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

        if (await isScanCancelled(true)) {
          return {
            status: "failed",
            errorCategory: "CANCELLED",
            errorMessage: "Scan cancelled by user",
          }
        }

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

        // The policy's maxDurationMinutes is a paid-plan cost control and must
        // bound the most expensive scan class too: pass the REMAINING wall-clock
        // budget to the engine runner so a REPO scan cannot outlive it even when
        // its self-reported spend and liveness keep advancing.
        const engineTimeoutMs = Math.max(0, scanRuntimeBudgetMs - (Date.now() - scanStartedAtMs))

        engineResult = await runEngine(
          {
            scanId,
            goal,
            mode,
            target: {
              id: target.id,
              type: target.type as TargetType,
              url: target.url,
              repoFullName: target.repoFullName,
              branch: target.branch,
              name: target.name,
            },
            instruction: buildVibeSecurityInstruction(goal),
            maxBudgetUsd,
          },
          scanId,
          engineTimeoutMs,
          isScanCancelled,
          // Sprint 10: metering hook — called on each agent-loop tick with
          // wall-clock elapsed ms. The hook is a no-op for now; the final
          // metering is done after the engine completes. This signal can be
          // used for real-time balance checks in a future iteration.
          (_elapsedMs: number) => {
            // Real-time metering hook — intentionally empty for now.
            // The final wall-clock duration is recorded after the engine exits.
          }
        )
      } else if (target.type === "WEB_APP" || target.type === "API") {
        engineResult = {
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
      } else {
        return {
          status: "failed",
          errorCategory: "INVALID_TARGET",
          errorMessage: `Unsupported target type for scanning: ${target.type}`,
        }
      }

      if (target.type !== "REPO" && globalScanTimeoutReached) {
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

      // ─── Sprint 10: Agent-minute metering (wall-clock) ──────────────────
      // Record wall-clock agent minutes consumed by the engine run.
      // Per D1 constraint: minutes are wall-clock, NOT "active-loop" or "thinking time".
      // Deep/Custom scans consume 3× minutes (applied inside recordAgentMinutes).
      const engineWallClockMs = Date.now() - scanStartedAtMs
      try {
        const billingAccount = await prisma.billingAccount.findUnique({
          where: { workspaceId },
          select: { currentPeriodStart: true },
        })
        await recordAgentMinutes(workspaceId, scanId, engineWallClockMs, {
          mode,
          phase: "engine_run",
          cycleStart: billingAccount?.currentPeriodStart ?? undefined,
        })

        // Check balance after metering — if exhausted, enter grace
        const balance = await getUsageBalance(workspaceId)
        if (balance.totalRemaining <= 0) {
          // Check if overage is available (Team plan with spend limit)
          const acct = await prisma.billingAccount.findUnique({
            where: { workspaceId },
            select: { currentPlan: true, spendLimitCents: true },
          })
          const overageAvailable = acct?.currentPlan === "TEAM" && (acct.spendLimitCents ?? 0) > 0

          if (overageAvailable) {
            // Debit overage for the remaining engine time
            const overageMinutes = Math.ceil(engineWallClockMs / 60_000)
            await debitOverage(workspaceId, overageMinutes, scanId, "engine_overage")
          } else {
            // Enter grace period (15min cap)
            const graceResult = await enterGrace(workspaceId, engineWallClockMs)
            if (!graceResult.shouldContinue) {
              // Grace exceeded — stop the scan
              await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
                errorCategory: "BUDGET_EXCEEDED",
                errorMessage: "Agent-minute balance exhausted and grace period exceeded",
              })
              return {
                status: "failed",
                errorCategory: "BUDGET_EXCEEDED",
                errorMessage: "Agent-minute balance exhausted and grace period exceeded",
              }
            }
          }
        }
      } catch (meterError) {
        log.warn("Failed to record agent minutes", {
          scanId,
          error: meterError instanceof Error ? meterError.message : String(meterError),
        })
        // Non-fatal: don't block the scan if metering fails
      }

      // Persist usage before deterministic scanners or finding persistence can
      // fail, so provider spend is never lost behind a downstream error.
      let { budgetExceeded, billedCostUsd, costReconciled, reconciliationReason } =
        await persistEngineUsageCheckpoint({
          scanId,
          maxBudgetUsd,
          llmUsage: engineResult.output.runRecord?.llm_usage,
          webSearchCostUsd: engineResult.output.runRecord?.webSearchCostUsd,
          usageExpected: target.type === "REPO",
        })
      const runRecord = engineResult.output.runRecord
      const exitInterpretation = interpretExitCode(engineResult.exitCode)
      const engineExecution =
        target.type === "REPO" && engineProfile && engineModel
          ? {
              model: engineModel,
              reasoningEffort: engineProfile.reasoningEffort,
              image: env.LYRASHIELD_IMAGE || null,
              ...(imageDigest(env.LYRASHIELD_IMAGE)
                ? { imageDigest: imageDigest(env.LYRASHIELD_IMAGE) }
                : {}),
              ...(runRecord?.engine_version ? { engineVersion: runRecord.engine_version } : {}),
              ...(runRecord?.prompt_bundle_hash
                ? { promptBundleHash: runRecord.prompt_bundle_hash }
                : {}),
              ...(runRecord?.max_output_tokens
                ? { maxOutputTokens: runRecord.max_output_tokens }
                : {}),
              ...(runRecord?.max_agents ? { maxAgents: runRecord.max_agents } : {}),
              ...(runRecord?.delegate_model ? { delegateModel: runRecord.delegate_model } : {}),
              ...(runRecord?.delegate_reasoning_effort
                ? { delegateReasoningEffort: runRecord.delegate_reasoning_effort }
                : {}),
              ...(runRecord?.model_routing_policy
                ? { routingPolicy: runRecord.model_routing_policy }
                : {}),
              ...(runRecord?.compaction_trigger_tokens
                ? { compactionTriggerTokens: runRecord.compaction_trigger_tokens }
                : {}),
              ...(runRecord?.compaction_target_tokens
                ? { compactionTargetTokens: runRecord.compaction_target_tokens }
                : {}),
              ...(engineResult.sourceRevision
                ? { sourceRevision: engineResult.sourceRevision }
                : {}),
              ...(typeof engineResult.sandboxRemoved === "boolean"
                ? { sandboxRemoved: engineResult.sandboxRemoved }
                : runRecord?.cleanup
                  ? { sandboxRemoved: runRecord.cleanup.sandbox_removed }
                  : {}),
            }
          : undefined

      if (engineResult.cancelled) {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      if (engineResult.budgetKilled) {
        const budgetMessage = "Protected run limit reached"
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
          engineFindingCount: 0,
          coverageIssues: [{ scanner: "engine", status: "bounded", reason: budgetMessage }],
          engineExecution,
          accounting: {
            maxBudgetUsd,
            billedCostUsd,
            reconciled: costReconciled,
            ...(reconciliationReason ? { reconciliationReason } : {}),
          },
        })
        await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: budgetMessage,
          ...(billedCostUsd !== null ? { actualCostCents: Math.round(billedCostUsd * 100) } : {}),
        })
        try {
          await notifyScanFailed(workspaceId, scanId, budgetMessage)
        } catch (notificationError) {
          log.warn("Failed to send budget-stop notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: budgetMessage,
        }
      }

      if (engineResult.timedOut) {
        const inactive = engineResult.timeoutReason === "INACTIVITY"
        const llmStalled = engineResult.timeoutReason === "LLM_STALL"
        const timeoutMessage = inactive
          ? "Scan engine stopped after no durable progress was observed"
          : llmStalled
            ? "Scan engine stalled: no model activity was observed while the run stayed active"
            : "Scan engine timed out before completing"
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
          engineFindingCount: 0,
          coverageIssues: [{ scanner: "engine", status: "bounded", reason: timeoutMessage }],
          engineExecution,
          accounting: {
            maxBudgetUsd,
            billedCostUsd,
            reconciled: costReconciled,
            ...(reconciliationReason ? { reconciliationReason } : {}),
          },
        })
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: inactive || llmStalled ? "ENGINE_INACTIVE" : "TIMEOUT",
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
        return {
          status: "failed",
          errorCategory: inactive || llmStalled ? "ENGINE_INACTIVE" : "TIMEOUT",
          errorMessage: timeoutMessage,
        }
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
        const stoppedForContentFilter = runRecord?.terminal_reason === "content_filter_stopped"
        const stoppedForEngineError = runRecord?.terminal_reason === "engine_stopped"
        const hasEngineFindings = (engineResult.output.vulnerabilities?.length ?? 0) > 0
        const errorCategory = stoppedForBudget
          ? "BUDGET_EXCEEDED"
          : stoppedForContentFilter
            ? "CONTENT_FILTER_STOPPED"
            : stoppedForEngineError
              ? "ENGINE_STOPPED"
              : "ENGINE_INCOMPLETE"
        const errorMessage = stoppedForBudget
          ? "Protected run limit reached"
          : stoppedForContentFilter
            ? "Engine stopped after content filter blocked the model; partial findings preserved"
            : stoppedForEngineError
              ? "Engine stopped after a model error; partial findings preserved"
              : "Engine did not produce a completed, valid result receipt"
        // Content filter stops and engine errors with findings are PARTIAL:
        // the engine produced results but did not complete its full scope.
        // Reporting these as COMPLETED would promise "we looked, and this is
        // what we found" when the run was actually truncated — false confidence
        // in a security tool. Without findings, they fail.
        const terminalStatus: ScanStatus = stoppedForBudget
          ? "STOPPED_BUDGET"
          : (stoppedForContentFilter || stoppedForEngineError) && hasEngineFindings
            ? "PARTIAL"
            : "FAILED"
        engineTerminalError = {
          status: terminalStatus,
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
      const scannerPhaseTimeoutMs =
        target.type === "REPO"
          ? env.SCANNER_PHASE_TIMEOUT_MS
          : resolveScannerPhaseTimeoutMs(scanRuntimeBudgetMs, Date.now() - scanStartedAtMs)

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
          apiSpecUrl: target.apiSpecUrl,
        },
        goal,
        mode,
        engineFindings: engineResult.output.vulnerabilities,
        workspaceDir: engineResult.sourceCheckoutPath ?? undefined,
        scannerPhaseTimeoutMs,
        isCancelled: target.type === "REPO" ? isScanCancelled : isCancelledOrTimedOut,
        urlProfile,
      })

      let aiSecuritySignals = orchestratorResult.aiAppSecuritySignals ?? []
      let triageSnapshot:
        | {
            status: "COMPLETED" | "DISABLED" | "FAILED" | "BUDGET_STOPPED"
            terminalReason: string | null
            policyVersion: string
            modelRoute: string
            inputChecksum: string
            redactionReceipt: string
            resultCount: number
          }
        | undefined
      const triageInput = buildEngineTriageInput(aiSecuritySignals, engineResult.sourceRevision)
      const triageFeatureEnabled = env.LYRASHIELD_AI_TRIAGE_ENABLED === "1"
      const workspacePlan =
        triageFeatureEnabled && triageInput
          ? await prisma.workspace
              .findFirst({
                where: { id: workspaceId, deletedAt: null },
                select: { plan: true },
              })
              .catch(() => null)
          : null
      const triageEligibility = eligibleForEngineTriage({
        enabled: triageFeatureEnabled,
        workspacePlan: workspacePlan?.plan ?? "FREE",
        mode,
        billedCostUsd,
        costReconciled,
        maxBudgetUsd,
        triageCapUsd: env.LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD,
      })
      let triageTerminalReason = triageEligibility.reason
      if (target.type === "REPO" && triageInput && triageEligibility.eligible) {
        try {
          const triageResult = await runEngineTriage({
            scanId,
            profile: resolveEngineProfile("STANDARD"),
            input: triageInput,
            maxBudgetUsd: triageEligibility.maxBudgetUsd!,
            timeoutMs: env.SCANNER_PHASE_TIMEOUT_MS,
            shouldCancel: isScanCancelled,
          })
          const artifact = triageResult.artifact
          if (artifact && triageResult.llmUsage) {
            const mergedUsage = mergeLlmUsage(
              engineResult.output.runRecord?.llm_usage,
              triageResult.llmUsage
            )
            if (mergedUsage) {
              const updatedAccounting = await persistEngineUsageCheckpoint({
                scanId,
                maxBudgetUsd,
                llmUsage: mergedUsage,
                webSearchCostUsd: engineResult.output.runRecord?.webSearchCostUsd,
                usageExpected: true,
              })
              budgetExceeded = updatedAccounting.budgetExceeded
              billedCostUsd = updatedAccounting.billedCostUsd
              costReconciled = updatedAccounting.costReconciled
              reconciliationReason = updatedAccounting.reconciliationReason
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
          } else if (artifact) {
            triageSnapshot = {
              status: artifact.status,
              terminalReason: artifact.terminalReason,
              policyVersion: artifact.policyVersion,
              modelRoute: artifact.modelRoute,
              inputChecksum: artifact.inputChecksum,
              redactionReceipt: artifact.redactionReceipt.inputChecksum,
              resultCount: 0,
            }
          }
          triageTerminalReason = triageSnapshot?.terminalReason ?? "TRIAGE_ARTIFACT_UNAVAILABLE"
        } catch {
          // An additive overlay can never fail the deterministic scan.
          triageTerminalReason = "TRIAGE_COMMAND_FAILED"
        }
      }
      if (target.type === "REPO" && triageFeatureEnabled && (triageSnapshot || triageInput)) {
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
          log.warn("Failed to persist AI-assisted triage terminal state", {
            scanId,
            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
          })
        )
      }

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
          `Vibe Security 50: ${coverage.reviewControlsRequested} code/URL review controls requested where applicable; ${coverage.matchedControlRanks.length} produced findings; ${coverage.evidenceControlsRequired} require deployment or human evidence`,
          coverage
        )
      } catch (eventErr) {
        log.warn("Failed to persist coverage_contract event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      const finalization = await withScanFinalizationClaim(scanId, workspaceId, async () => {
        // 5. Persist normalized findings
        const persistedFindings = await persistFindings({
          scanId,
          workspaceId,
          targetId,
          vulnerabilities: orchestratorResult.allFindings,
        })

        const newFindings = persistedFindings.filter((f) => f.isNew).length
        const dupFindings = persistedFindings.length - newFindings

        // engineResult.output.summary describes only the agentic engine's own
        // vulnerabilities.json artifact (see parseEngineOutput). It never sees the
        // SCA, secrets, agent-config, or URL scanner findings that the
        // orchestrator merges in, nor the false-positive filtering and dedup that
        // happen afterward — so on a run where the engine layer alone found
        // nothing, it reads "0 finding(s) reported" next to a persisted finding
        // count that can be dozens. That text becomes scan.summary, which the
        // dashboard, the private assurance report, and completion notifications
        // all display verbatim, so the mismatch is user-facing, not just internal.
        // Leave the engine's own text untouched when it already matches what was
        // persisted; only correct it when the two disagree, so this stays a
        // targeted fix rather than a rewrite of copy that was already accurate.
        const scanSummary =
          persistedFindings.length !== engineResult.output.findingCount
            ? `${engineResult.output.summary} ${persistedFindings.length} finding(s) retained after all scanner layers and deduplication.`
            : engineResult.output.summary

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

        // Persist the result manifest for every outcome, including a failed or
        // incomplete engine, so coverage receipts are always available. The
        // manifest must exist BEFORE retest finalization: completeRetestsForScan
        // binds its verdict to the stored baseline/retest checksums, so a crash
        // between manifest and retests resumes finalization from the receipt
        // evidence instead of skipping it.
        await prisma.scan.update({
          where: { id: scanId },
          data: { summary: scanSummary },
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
          aiAppSecurityDiscovery: orchestratorResult.aiAppSecurityDiscovery,
          matchedControlRanks: coverage.matchedControlRanks,
          urlExecution: orchestratorResult.urlExecution,
          engineExecution,
          accounting: {
            maxBudgetUsd,
            billedCostUsd,
            reconciled: costReconciled,
            ...(reconciliationReason ? { reconciliationReason } : {}),
          },
        })

        await completeRetestsForScan({ scanId, workspaceId })

        if (engineTerminalError) {
          await updateScanStatus(scanId, engineTerminalError.status, {
            errorCategory: engineTerminalError.errorCategory,
            errorMessage: engineTerminalError.errorMessage,
            ...(billedCostUsd !== null ? { actualCostCents: Math.round(billedCostUsd * 100) } : {}),
          })
          return {
            persistedFindings,
            newFindings,
            scanSummary,
            terminalResult: {
              status: "failed" as const,
              errorCategory: engineTerminalError.errorCategory,
              errorMessage: engineTerminalError.errorMessage,
            },
          }
        }

        if (budgetExceeded) {
          await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: "Protected run limit reached",
            actualCostCents: Math.round(billedCostUsd! * 100),
          })
          return {
            persistedFindings,
            newFindings,
            scanSummary,
            terminalResult: {
              status: "failed" as const,
              errorCategory: "BUDGET_EXCEEDED",
              errorMessage: "Protected run limit reached",
            },
          }
        }
        // Retests may validate a pending fix and change the target's scoreable
        // state. Freeze the score only after those outcomes are persisted.
        await completeScanWithScore(scanId, workspaceId, scanSummary)
        return { persistedFindings, newFindings, scanSummary, terminalResult: null }
      })

      if (finalization.status === "cancelled") {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }
      const { persistedFindings, newFindings, scanSummary, terminalResult } = finalization.value
      if (terminalResult) {
        if (terminalResult.errorCategory !== "BUDGET_EXCEEDED") {
          try {
            await notifyScanFailed(workspaceId, scanId, terminalResult.errorMessage)
          } catch (notificationError) {
            log.warn("Failed to send scan failure notification", {
              scanId,
              error:
                notificationError instanceof Error
                  ? notificationError.message
                  : String(notificationError),
            })
          }
        }
        return terminalResult
      }

      if (orchestratorResult.aiAppSecurityCoverage) {
        try {
          await createAiSecurityScoreSnapshot(scanId, workspaceId, {
            signals: aiSecuritySignals,
            coverage: orchestratorResult.aiAppSecurityCoverage,
            ai03: orchestratorResult.ai03Coverage ?? {
              resolutionStatus: "UNSUPPORTED",
              advisoryStatus: "UNAVAILABLE",
              fresh: false,
            },
            ...(triageSnapshot ? { triage: triageSnapshot } : {}),
          })
        } catch (aiScoreErr) {
          log.warn("Failed to create AI security score snapshot", {
            scanId,
            error: aiScoreErr instanceof Error ? aiScoreErr.message : String(aiScoreErr),
          })
        }
      }
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
          notifyScanCompleted(workspaceId, scanId, scanSummary, persistedFindings.length),
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
        summary: scanSummary,
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
        // ponytail: let BullMQ retain the terminal infrastructure failure when the DB cannot.
        throw error
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
      } catch (cleanupError) {
        const error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        log.error("Engine workspace cleanup requires operator attention", { scanId, error })
        try {
          await addScanEvent(
            scanId,
            "cleanup_failed",
            "error",
            "Engine workspace cleanup requires operator attention",
            { error }
          )
        } catch (eventError) {
          log.error("Failed to persist cleanup failure event", {
            scanId,
            error: eventError instanceof Error ? eventError.message : String(eventError),
          })
        }
      }
    }
  }) // end runWithWorkspaceContext
}
