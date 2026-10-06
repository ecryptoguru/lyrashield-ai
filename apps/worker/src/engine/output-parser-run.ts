import { logger } from "@lyrashield/logger"
import {
  checkRunRecordSchemaVersion,
  engineRunRecordSchema,
  promptCacheReceiptSchema,
} from "./engine-output-schema"
import { boundedString, HTTP_EXCHANGE_ID_PATTERN, MAX_DB_INTEGER } from "./output-parser-common"
import type { EngineRunRecord } from "./output-parser-types"
import { sumUsdCosts } from "./gpt56-pricing"

const MAX_RUN_TARGETS = 100
const MAX_LLM_USAGE_NODES = 500
const MAX_DB_DECIMAL_12_6 = 1_000_000
const MAX_LLM_USAGE_REQUESTS = 10_000
const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
function usageInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DB_INTEGER
    ? value
    : undefined
}

function usageCost(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < MAX_DB_DECIMAL_12_6
    ? value
    : undefined
}

function webSearchCostUsd(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined
  const costs: number[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
    const cost = usageCost((entry as Record<string, unknown>).cost)
    if (cost === undefined) return undefined
    costs.push(cost)
  }
  return value.length > 0 ? (sumUsdCosts(...costs) ?? undefined) : undefined
}

function findUsageMetric(
  value: unknown,
  keys: ReadonlySet<string>,
  validate: (candidate: unknown) => number | undefined,
  visited = { count: 0, truncated: false },
  depth = 0
): number | undefined {
  if (value === null) return undefined
  if (depth > 4 || visited.count >= MAX_LLM_USAGE_NODES) {
    if (typeof value === "object") visited.truncated = true
    return undefined
  }
  visited.count += 1
  if (Array.isArray(value)) {
    let total: number | undefined
    for (const item of value) {
      if (visited.count >= MAX_LLM_USAGE_NODES) {
        visited.truncated = true
        break
      }
      const candidate = findUsageMetric(item, keys, validate, visited, depth + 1)
      if (candidate !== undefined) {
        total = validate((total ?? 0) + candidate)
        if (total === undefined) return undefined
      }
    }
    return visited.truncated ? undefined : total
  }
  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const direct = validate(record[key])
    if (direct !== undefined) return direct
  }
  let total: number | undefined
  for (const property in record) {
    if (!Object.prototype.hasOwnProperty.call(record, property)) continue
    if (visited.count >= MAX_LLM_USAGE_NODES) {
      visited.truncated = true
      break
    }
    const candidate = findUsageMetric(record[property], keys, validate, visited, depth + 1)
    if (candidate !== undefined) {
      total = validate((total ?? 0) + candidate)
      if (total === undefined) return undefined
    }
  }
  return visited.truncated ? undefined : total
}

function normalizeLlmUsage(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const inputTokenDetails =
    typeof record.input_tokens_details === "object" &&
    record.input_tokens_details !== null &&
    !Array.isArray(record.input_tokens_details)
      ? (record.input_tokens_details as Record<string, unknown>)
      : undefined
  // Prefer the aggregate root counters. A wide per-request usage payload may
  // exceed the bounded recursive traversal, which previously dropped cached
  // input tokens and made the stored cost impossible to reconcile.
  const directInteger = (key: string) => usageInteger(record[key])
  const requests = findUsageMetric(
    record,
    new Set(["request_count", "requests_count", "requests"]),
    usageInteger
  )
  const requestCount =
    requests ?? (Array.isArray(record.requests) ? usageInteger(record.requests.length) : undefined)
  const inputTokens =
    directInteger("input_tokens") ??
    findUsageMetric(
      record,
      new Set(["input_tokens", "prompt_tokens", "input_token_count"]),
      usageInteger
    )
  const cachedInputTokens =
    usageInteger(inputTokenDetails?.cached_tokens) ??
    directInteger("cached_input_tokens") ??
    sumRequestUsageDetail(record.request_usage_entries, "cached_tokens") ??
    findUsageMetric(record, new Set(["cached_input_tokens", "cached_tokens"]), usageInteger)
  const cacheWriteInputTokens =
    usageInteger(inputTokenDetails?.cache_write_tokens) ??
    directInteger("cache_write_input_tokens") ??
    sumRequestUsageDetail(record.request_usage_entries, "cache_write_tokens") ??
    findUsageMetric(
      record,
      new Set(["cache_write_input_tokens", "cache_write_tokens"]),
      usageInteger
    )
  const outputTokens =
    directInteger("output_tokens") ??
    findUsageMetric(
      record,
      new Set(["output_tokens", "completion_tokens", "output_token_count"]),
      usageInteger
    )
  const reportedTotalTokens = findUsageMetric(
    record,
    new Set(["total_tokens", "token_count"]),
    usageInteger
  )
  const totalTokens =
    reportedTotalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? usageInteger((inputTokens ?? 0) + (outputTokens ?? 0))
      : undefined)
  const totalCostUsd = ["total_cost_usd", "cost_usd", "total_cost", "cost"]
    .map((key) => usageCost(record[key]))
    .find((candidate) => candidate !== undefined)
  const requestUsageBuckets = normalizeRequestUsageBuckets(record.request_usage_entries)
  const reportedModelUsageBuckets = normalizeModelUsageBuckets(record.model_usage_buckets)
  const normalized = {
    ...(typeof record.accounting_complete === "boolean"
      ? { accountingComplete: record.accounting_complete }
      : typeof record.accountingComplete === "boolean"
        ? { accountingComplete: record.accountingComplete }
        : {}),
    ...(requestCount !== undefined ? { request_count: requestCount } : {}),
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined
      ? { cache_write_input_tokens: cacheWriteInputTokens }
      : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
    ...requestUsageBuckets,
    ...(requestUsageBuckets.model_usage_buckets
      ? {}
      : reportedModelUsageBuckets
        ? { model_usage_buckets: reportedModelUsageBuckets }
        : {}),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

const USAGE_COUNTER_KEYS = [
  "request_count",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "total_tokens",
] as const
const USAGE_BUCKET_KEYS = [
  "standard_input_tokens",
  "standard_cached_input_tokens",
  "standard_cache_write_input_tokens",
  "standard_output_tokens",
  "long_input_tokens",
  "long_cached_input_tokens",
  "long_cache_write_input_tokens",
  "long_output_tokens",
] as const

/**
 * Combines independently metered engine phases only when both receipts expose
 * exact per-request GPT-5.6 buckets. An incomplete receipt stays unpriceable.
 */
export function mergeLlmUsage(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const normalizedBase = normalizeLlmUsage(base)
  const normalizedOverlay = normalizeLlmUsage(overlay)
  if (!normalizedBase || !normalizedOverlay) return undefined

  const merged: Record<string, unknown> = {}
  if ("accountingComplete" in normalizedBase || "accountingComplete" in normalizedOverlay) {
    merged.accountingComplete =
      normalizedBase.accountingComplete === true && normalizedOverlay.accountingComplete === true
  }
  for (const key of USAGE_COUNTER_KEYS) {
    const baseValue = usageInteger(normalizedBase[key])
    const overlayValue = usageInteger(normalizedOverlay[key])
    if (baseValue === undefined || overlayValue === undefined) return undefined
    const total = usageInteger(baseValue + overlayValue)
    if (total === undefined) return undefined
    merged[key] = total
  }

  const baseBuckets = normalizedBase.model_usage_buckets
  const overlayBuckets = normalizedOverlay.model_usage_buckets
  if (!Array.isArray(baseBuckets) || !Array.isArray(overlayBuckets)) return undefined
  const byModel = new Map<string, Record<(typeof USAGE_BUCKET_KEYS)[number], number>>()
  for (const bucket of [...baseBuckets, ...overlayBuckets]) {
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return undefined
    const record = bucket as Record<string, unknown>
    const model = boundedPricedModel(record.model)?.trim()
    if (!model) return undefined
    const current =
      byModel.get(model) ??
      ({
        standard_input_tokens: 0,
        standard_cached_input_tokens: 0,
        standard_cache_write_input_tokens: 0,
        standard_output_tokens: 0,
        long_input_tokens: 0,
        long_cached_input_tokens: 0,
        long_cache_write_input_tokens: 0,
        long_output_tokens: 0,
      } satisfies Record<(typeof USAGE_BUCKET_KEYS)[number], number>)
    for (const key of USAGE_BUCKET_KEYS) {
      const value = usageInteger(record[key])
      if (value === undefined) return undefined
      const total = usageInteger((current[key] ?? 0) + value)
      if (total === undefined) return undefined
      current[key] = total
    }
    byModel.set(model, current)
  }
  if (byModel.size === 0 || byModel.size > 3) return undefined
  merged.model_usage_buckets = [...byModel].map(([model, buckets]) => ({ model, ...buckets }))

  const baseCost = usageCost(normalizedBase.total_cost_usd)
  const overlayCost = usageCost(normalizedOverlay.total_cost_usd)
  if (baseCost !== undefined && overlayCost !== undefined) {
    const cost = usageCost(baseCost + overlayCost)
    if (cost === undefined) return undefined
    merged.total_cost_usd = cost
  }
  return merged
}

function detailInteger(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) return detailInteger(value[0], key)
  if (typeof value !== "object" || value === null) return undefined
  return usageInteger((value as Record<string, unknown>)[key])
}

function sumRequestUsageDetail(value: unknown, key: string): number | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_USAGE_REQUESTS) {
    return undefined
  }
  let total = 0
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
    const details = (entry as Record<string, unknown>).input_tokens_details
    const amount = detailInteger(details, key)
    if (amount === undefined) return undefined
    const nextTotal = usageInteger(total + amount)
    if (nextTotal === undefined) return undefined
    total = nextTotal
  }
  return total
}

function boundedPricedModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined
  const normalized = value.toLowerCase().replaceAll("_", "-")
  return /(?:^|[/.-])(?:gpt-5\.6-(?:terra|luna)|gpt-6-(?:sol|luna))(?:$|[/.-])/.test(normalized)
    ? value
    : undefined
}

function normalizeRequestUsageBuckets(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_USAGE_REQUESTS) {
    return {}
  }
  const buckets = {
    standard_input_tokens: 0,
    standard_cached_input_tokens: 0,
    standard_cache_write_input_tokens: 0,
    standard_output_tokens: 0,
    long_input_tokens: 0,
    long_cached_input_tokens: 0,
    long_cache_write_input_tokens: 0,
    long_output_tokens: 0,
  }
  const modelBuckets = new Map<string, typeof buckets>()
  let everyEntryHasModel = true
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return {}
    const record = entry as Record<string, unknown>
    const inputTokens = usageInteger(record.input_tokens)
    const outputTokens = usageInteger(record.output_tokens)
    const model = boundedPricedModel(record.model)?.trim()
    const isGpt6 = model ? /gpt-6-(?:sol|luna)$/i.test(model) : false
    const cachedInputTokens =
      detailInteger(record.input_tokens_details, "cached_tokens") ?? (isGpt6 ? undefined : 0)
    const cacheWriteInputTokens =
      detailInteger(record.input_tokens_details, "cache_write_tokens") ?? (isGpt6 ? undefined : 0)
    if (!model) everyEntryHasModel = false
    if (
      inputTokens === undefined ||
      outputTokens === undefined ||
      cachedInputTokens === undefined ||
      cacheWriteInputTokens === undefined ||
      cachedInputTokens > inputTokens ||
      cacheWriteInputTokens > inputTokens - cachedInputTokens
    ) {
      return {}
    }
    const prefix = inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS ? "long" : "standard"
    buckets[`${prefix}_input_tokens` as keyof typeof buckets] += inputTokens
    buckets[`${prefix}_cached_input_tokens` as keyof typeof buckets] += cachedInputTokens
    buckets[`${prefix}_cache_write_input_tokens` as keyof typeof buckets] += cacheWriteInputTokens
    buckets[`${prefix}_output_tokens` as keyof typeof buckets] += outputTokens
    if (model && everyEntryHasModel) {
      const perModel = modelBuckets.get(model) ?? {
        standard_input_tokens: 0,
        standard_cached_input_tokens: 0,
        standard_cache_write_input_tokens: 0,
        standard_output_tokens: 0,
        long_input_tokens: 0,
        long_cached_input_tokens: 0,
        long_cache_write_input_tokens: 0,
        long_output_tokens: 0,
      }
      perModel[`${prefix}_input_tokens` as keyof typeof perModel] += inputTokens
      perModel[`${prefix}_cached_input_tokens` as keyof typeof perModel] += cachedInputTokens
      perModel[`${prefix}_cache_write_input_tokens` as keyof typeof perModel] +=
        cacheWriteInputTokens
      perModel[`${prefix}_output_tokens` as keyof typeof perModel] += outputTokens
      modelBuckets.set(model, perModel)
      if (modelBuckets.size > 3) everyEntryHasModel = false
    }
  }
  return {
    ...buckets,
    ...(everyEntryHasModel && modelBuckets.size > 0
      ? {
          model_usage_buckets: [...modelBuckets].map(([model, usage]) => ({ model, ...usage })),
        }
      : {}),
  }
}

/** Validates the already-normalized buckets persisted in a prior engine receipt. */
function normalizeModelUsageBuckets(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return undefined
  const normalized: Array<Record<string, unknown>> = []
  for (const bucket of value) {
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return undefined
    const record = bucket as Record<string, unknown>
    const model = boundedPricedModel(record.model)?.trim()
    if (!model) return undefined
    const entry: Record<string, unknown> = { model }
    for (const key of USAGE_BUCKET_KEYS) {
      const amount = usageInteger(record[key])
      if (amount === undefined) return undefined
      entry[key] = amount
    }
    normalized.push(entry)
  }
  return normalized
}
export function parseRunJson(raw: string): EngineRunRecord | null {
  if (!raw.trim()) return null
  try {
    const data = JSON.parse(raw)
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null
    const record = data as Record<string, unknown>
    const runId = boundedString(record.run_id)
    const status = boundedString(record.status)
    if (!runId?.trim() || !status?.trim()) {
      logger.warn("run.json is missing required run metadata")
      return null
    }

    const targetsInfo = Array.isArray(record.targets_info)
      ? record.targets_info.slice(0, MAX_RUN_TARGETS).flatMap((target) => {
          if (typeof target !== "object" || target === null || Array.isArray(target)) return []
          const sourcePath = boundedString(
            (target as { details?: { cloned_repo_path?: unknown } }).details?.cloned_repo_path
          )
          return sourcePath ? [{ details: { cloned_repo_path: sourcePath } }] : []
        })
      : undefined
    const llmUsage = normalizeLlmUsage(record.llm_usage)
    const routedModel = boundedPricedModel(record.model)
    if (llmUsage && routedModel && /gpt-6-(?:sol|luna)$/i.test(routedModel)) {
      // Keep the route visible when malformed request entries erased model buckets.
      // This makes incomplete GPT-6 accounting explicit, never billable by fallback.
      llmUsage.model = routedModel
      llmUsage.accountingComplete =
        llmUsage.accountingComplete === true && Array.isArray(llmUsage.model_usage_buckets)
    }
    const promptBundleHash = boundedString(record.prompt_bundle_hash)
    const promptCache = promptCacheReceiptSchema.safeParse(record.prompt_cache)
    const delegateModel = boundedString(record.delegate_model)
    const delegateReasoningEffort = boundedString(record.delegate_reasoning_effort)
    const modelRoutingPolicy = boundedString(record.model_routing_policy)
    const compactionTriggerTokens = usageInteger(record.compaction_trigger_tokens)
    const compactionTargetTokens = usageInteger(record.compaction_target_tokens)
    const maxOutputTokens = usageInteger(record.max_output_tokens)
    const maxAgents = usageInteger(record.max_agents)
    const searchCost = webSearchCostUsd(record.web_search_usage)
    const cleanup =
      typeof record.cleanup === "object" &&
      record.cleanup !== null &&
      !Array.isArray(record.cleanup)
        ? (record.cleanup as { sandbox_removed?: unknown })
        : undefined

    const runRecord: EngineRunRecord = {
      ...(boundedString(record.schema_version)
        ? { schema_version: boundedString(record.schema_version) }
        : {}),
      run_id: runId,
      run_name: boundedString(record.run_name) ?? null,
      start_time: boundedString(record.start_time) ?? "",
      end_time: boundedString(record.end_time) ?? null,
      status,
      ...(targetsInfo ? { targets_info: targetsInfo } : {}),
      ...(llmUsage ? { llm_usage: llmUsage } : {}),
      ...(searchCost !== undefined ? { webSearchCostUsd: searchCost } : {}),
      ...(boundedString(record.engine_version)
        ? { engine_version: boundedString(record.engine_version) }
        : {}),
      ...(promptBundleHash && /^[a-f0-9]{64}$/i.test(promptBundleHash)
        ? { prompt_bundle_hash: promptBundleHash.toLowerCase() }
        : {}),
      ...(promptCache.success ? { prompt_cache: promptCache.data } : {}),
      ...(boundedString(record.model) ? { model: boundedString(record.model) } : {}),
      ...(boundedString(record.reasoning_effort)
        ? { reasoning_effort: boundedString(record.reasoning_effort) }
        : {}),
      ...(delegateModel ? { delegate_model: delegateModel } : {}),
      ...(delegateReasoningEffort ? { delegate_reasoning_effort: delegateReasoningEffort } : {}),
      ...(modelRoutingPolicy ? { model_routing_policy: modelRoutingPolicy } : {}),
      ...(compactionTriggerTokens !== undefined
        ? { compaction_trigger_tokens: compactionTriggerTokens }
        : {}),
      ...(compactionTargetTokens !== undefined
        ? { compaction_target_tokens: compactionTargetTokens }
        : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(maxAgents !== undefined ? { max_agents: maxAgents } : {}),
      ...(typeof cleanup?.sandbox_removed === "boolean"
        ? { cleanup: { sandbox_removed: cleanup.sandbox_removed } }
        : {}),
      ...(boundedString(record.scan_mode) ? { scan_mode: boundedString(record.scan_mode) } : {}),
      ...(boundedString(record.terminal_reason)
        ? { terminal_reason: boundedString(record.terminal_reason) }
        : {}),
      ...(Number.isInteger(record.report_artifacts_revision) &&
      (record.report_artifacts_revision as number) >= 0
        ? { report_artifacts_revision: record.report_artifacts_revision as number }
        : {}),
      ...(parseEvidenceExportOutcome(record.evidence_export)
        ? { evidence_export: parseEvidenceExportOutcome(record.evidence_export) }
        : {}),
    }

    const parsed = engineRunRecordSchema.safeParse(runRecord)
    if (!parsed.success) {
      logger.warn("Engine output: run.json failed strict schema validation", {
        runId,
        errors: parsed.error.issues.map((issue) => issue.message),
      })
      return null
    }

    // Tripwire for cross-repo contract drift. An error-level check means an
    // unsupported MAJOR: the record is rejected rather than ingested under a
    // contract the worker does not understand.
    const versionCheck = checkRunRecordSchemaVersion(parsed.data.schema_version)
    if (versionCheck) {
      logger[versionCheck.level === "error" ? "error" : "warn"](
        "Engine output: run.json schema version check",
        { runId, schemaVersion: parsed.data.schema_version ?? null, ...versionCheck }
      )
      if (versionCheck.level === "error") return null
    }

    return runRecord
  } catch (err) {
    logger.error("Failed to parse run.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Bounded parse of the run-level evidence_export outcome stamp (1.1). */
function parseEvidenceExportOutcome(
  value: unknown
): NonNullable<EngineRunRecord["evidence_export"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as {
    status?: unknown
    reason?: unknown
    exchanges?: unknown
    missing_request_ids?: unknown
  }
  const status = ["exported", "partial", "skipped", "failed"].includes(String(record.status))
    ? (String(record.status) as "exported" | "partial" | "skipped" | "failed")
    : undefined
  const reason = boundedString(record.reason)
  const exchanges =
    Number.isInteger(record.exchanges) && (record.exchanges as number) >= 0
      ? (record.exchanges as number)
      : undefined
  const missing = Array.isArray(record.missing_request_ids)
    ? record.missing_request_ids
        .filter((id): id is string => typeof id === "string" && HTTP_EXCHANGE_ID_PATTERN.test(id))
        .slice(0, 500)
    : undefined
  if (status === undefined && reason === undefined && exchanges === undefined && !missing?.length) {
    return undefined
  }
  return {
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(exchanges !== undefined ? { exchanges } : {}),
    ...(missing?.length ? { missing_request_ids: missing } : {}),
  }
}
