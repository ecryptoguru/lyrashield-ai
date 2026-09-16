import { addScanEvent, prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import type { EngineRunRecord } from "../../engine/output-parser"
import type { EngineProfile } from "../../engine/runner"
import {
  calculateGpt56CostUsd,
  calculateGpt56CostUsdFromBuckets,
  calculateGpt56CostUsdFromModelBuckets,
  GPT_56_PRICING_EFFECTIVE_DATE,
  GPT_56_PRICING_SOURCE,
  type Gpt56ModelUsageBuckets,
} from "../../engine/gpt56-pricing"
import type { ScannerCoverageIssue } from "../../engine/scanner-coverage"

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

export function engineRoutingCoverageIssue(
  profile: EngineProfile,
  runRecord: EngineRunRecord | null
): ScannerCoverageIssue | null {
  if (!runRecord) return null
  const expectedPolicy =
    profile.model && profile.delegateModel
      ? `coordinator=${profile.model}@${profile.reasoningEffort};delegate=${profile.delegateModel}@${profile.delegateReasoningEffort};v=1`
      : null
  const mismatches = [
    profile.model !== undefined && runRecord.model !== profile.model ? "model" : null,
    runRecord.reasoning_effort !== profile.reasoningEffort ? "reasoning_effort" : null,
    profile.delegateModel !== undefined && runRecord.delegate_model !== profile.delegateModel
      ? "delegate_model"
      : null,
    runRecord.delegate_reasoning_effort !== profile.delegateReasoningEffort
      ? "delegate_reasoning_effort"
      : null,
    expectedPolicy !== null && runRecord.model_routing_policy !== expectedPolicy
      ? "model_routing_policy"
      : null,
  ].filter((field): field is string => field !== null)

  return mismatches.length === 0
    ? null
    : {
        scanner: "engine",
        status: "partial",
        subject: "routing-receipt",
        reason: `Engine routing receipt did not match the worker profile: ${mismatches.join(", ")}`,
      }
}

export type UsageSummary = {
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

export function shouldRecordAgentMinutes(
  scanId: string,
  exitStatus: "COMPLETED" | "PARTIAL" | "FAILED",
  runRecord: EngineRunRecord | null,
  opts: { cancelled?: boolean } = {}
): boolean {
  if (!runRecord) return false
  if (runRecord.run_id !== scanId || runRecord.run_name !== scanId) return false

  // Founder-confirmed billing rules (2026-08-29):
  // - A user-CANCELLED scan bills for the period actually used. It is billed
  //   (elapsed time, no floor) whenever engine work was observed.
  // - Any OTHER failed terminal state is NEVER billed, even if provider usage
  //   was recorded before the failure (if the customer got nothing usable,
  //   they pay nothing).
  const validCompletedReceipt = exitStatus === "COMPLETED" && runRecord.status === "completed"
  if (validCompletedReceipt) return true

  if (exitStatus === "FAILED" && !opts.cancelled) return false

  if (!runRecord.llm_usage) return false
  const usage = extractUsageSummary(runRecord.llm_usage)
  return [
    usage.requestCount,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.engineReportedCostUsd,
    ...(usage.pricingBuckets ? Object.values(usage.pricingBuckets) : []),
    ...(usage.modelPricingBuckets
      ? usage.modelPricingBuckets.flatMap((bucket) => [
          bucket.standardInputTokens,
          bucket.standardCachedInputTokens,
          bucket.standardCacheWriteInputTokens,
          bucket.standardOutputTokens,
          bucket.longInputTokens,
          bucket.longCachedInputTokens,
          bucket.longCacheWriteInputTokens,
          bucket.longOutputTokens,
        ])
      : []),
  ].some((value) => typeof value === "number" && value > 0)
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
    llmUsage["accountingComplete"] !== false &&
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
  const reconciliationStatus =
    llmUsage["accountingComplete"] === false
      ? "incomplete_provider_receipts"
      : modelMixUnpriceable
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
      accountingComplete: llmUsage["accountingComplete"] !== false,
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
            llmUsage["accountingComplete"] === false
              ? "Some started provider requests have no final usage receipt"
              : rateCardCostUsd === null
                ? "Complete per-request GPT-5.6 usage buckets were unavailable"
                : "Engine-reported cost did not match the GPT-5.6 rate-card calculation",
        }),
  }
}
