const GPT_6_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const USD_COST_UNITS_PER_DOLLAR = 10_000_000_000
const USD_COST_UNITS_PER_RATE_TOKEN = USD_COST_UNITS_PER_DOLLAR / 1_000_000
export const GPT_6_PRICING_EFFECTIVE_DATE = "2026-09-22"
export const GPT_6_PRICING_SOURCE =
  "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"

export const GPT_6_PRICING_USD_PER_MILLION = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
} as const
const MODEL_PRICING_USD_PER_MILLION = {
  ...GPT_6_PRICING_USD_PER_MILLION,
}

type Gpt6UsageBuckets = {
  standardInputTokens: number | null
  standardCachedInputTokens: number | null
  standardCacheWriteInputTokens: number | null
  standardOutputTokens: number | null
  longInputTokens: number | null
  longCachedInputTokens: number | null
  longCacheWriteInputTokens: number | null
  longOutputTokens: number | null
}

export type Gpt6ModelUsageBuckets = Gpt6UsageBuckets & { model: string }

function resolveRate(model: string | undefined) {
  const modelId = model?.trim().toLowerCase().split("/").pop()
  return modelId
    ? MODEL_PRICING_USD_PER_MILLION[modelId as keyof typeof MODEL_PRICING_USD_PER_MILLION]
    : undefined
}

function calculateBucketCostUnits(
  rate: (typeof MODEL_PRICING_USD_PER_MILLION)[keyof typeof MODEL_PRICING_USD_PER_MILLION],
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  multiplier: number
) {
  const cached = Math.min(cachedInputTokens, inputTokens)
  const cacheWrite = Math.min(cacheWriteInputTokens, inputTokens - cached)
  const uncached = inputTokens - cached - cacheWrite
  return Math.round(
    uncached * rate.input * USD_COST_UNITS_PER_RATE_TOKEN * multiplier +
      cached * rate.cachedInput * USD_COST_UNITS_PER_RATE_TOKEN * multiplier +
      cacheWrite * rate.cacheWriteInput * USD_COST_UNITS_PER_RATE_TOKEN * multiplier +
      outputTokens * rate.output * USD_COST_UNITS_PER_RATE_TOKEN * (multiplier === 1 ? 1 : 1.5)
  )
}

function hasValidCacheBuckets(
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number
): boolean {
  return (
    cachedInputTokens <= inputTokens && cacheWriteInputTokens <= inputTokens - cachedInputTokens
  )
}

type Gpt6CostBreakdownUnits = {
  standardInput: number
  cachedInputRead: number
  cacheWriteInput: number
  output: number
  uncachedCounterfactual: number
}

function calculateBucketCostBreakdownUnits(
  rate: (typeof MODEL_PRICING_USD_PER_MILLION)[keyof typeof MODEL_PRICING_USD_PER_MILLION],
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  multiplier: number
): Gpt6CostBreakdownUnits {
  const cached = Math.min(cachedInputTokens, inputTokens)
  const cacheWrite = Math.min(cacheWriteInputTokens, inputTokens - cached)
  const standard = inputTokens - cached - cacheWrite
  const standardInput = Math.round(
    standard * rate.input * USD_COST_UNITS_PER_RATE_TOKEN * multiplier
  )
  const cachedInputRead = Math.round(
    cached * rate.cachedInput * USD_COST_UNITS_PER_RATE_TOKEN * multiplier
  )
  const cacheWriteInput = Math.round(
    cacheWrite * rate.cacheWriteInput * USD_COST_UNITS_PER_RATE_TOKEN * multiplier
  )
  const output = Math.round(
    outputTokens * rate.output * USD_COST_UNITS_PER_RATE_TOKEN * (multiplier === 1 ? 1 : 1.5)
  )
  const uncachedCounterfactual = Math.round(
    inputTokens * rate.input * USD_COST_UNITS_PER_RATE_TOKEN * multiplier +
      outputTokens * rate.output * USD_COST_UNITS_PER_RATE_TOKEN * (multiplier === 1 ? 1 : 1.5)
  )
  return { standardInput, cachedInputRead, cacheWriteInput, output, uncachedCounterfactual }
}

function calculateUsageBucketsCostUnits(
  model: string | undefined,
  usage: Gpt6UsageBuckets
): number | null {
  const rate = resolveRate(model)
  const usageValues = [
    usage.standardInputTokens,
    usage.standardCachedInputTokens,
    usage.standardCacheWriteInputTokens,
    usage.standardOutputTokens,
    usage.longInputTokens,
    usage.longCachedInputTokens,
    usage.longCacheWriteInputTokens,
    usage.longOutputTokens,
  ]
  if (
    !rate ||
    usageValues.some((value) => value === null || !Number.isSafeInteger(value) || value < 0)
  ) {
    return null
  }
  if (
    !hasValidCacheBuckets(
      usage.standardInputTokens!,
      usage.standardCachedInputTokens!,
      usage.standardCacheWriteInputTokens!
    ) ||
    !hasValidCacheBuckets(
      usage.longInputTokens!,
      usage.longCachedInputTokens!,
      usage.longCacheWriteInputTokens!
    )
  ) {
    return null
  }
  const costUnits =
    calculateBucketCostUnits(
      rate,
      usage.standardInputTokens!,
      usage.standardCachedInputTokens!,
      usage.standardCacheWriteInputTokens!,
      usage.standardOutputTokens!,
      1
    ) +
    calculateBucketCostUnits(
      rate,
      usage.longInputTokens!,
      usage.longCachedInputTokens!,
      usage.longCacheWriteInputTokens!,
      usage.longOutputTokens!,
      2
    )
  return Number.isSafeInteger(costUnits) ? costUnits : null
}

function usdCostToUnits(costUsd: number): number | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return null
  const units = Math.round(costUsd * USD_COST_UNITS_PER_DOLLAR)
  return Number.isSafeInteger(units) ? units : null
}

export function sumUsdCosts(...costsUsd: number[]): number | null {
  let totalUnits = 0
  for (const costUsd of costsUsd) {
    const units = usdCostToUnits(costUsd)
    if (units === null) return null
    totalUnits += units
    if (!Number.isSafeInteger(totalUnits)) return null
  }
  return totalUnits / USD_COST_UNITS_PER_DOLLAR
}

export function usdCostsMatch(firstCostUsd: number, secondCostUsd: number): boolean {
  const firstUnits = usdCostToUnits(firstCostUsd)
  return firstUnits !== null && firstUnits === usdCostToUnits(secondCostUsd)
}

/**
 * Calculates the official rate-card amount from bounded per-request buckets.
 * A request above 272k uses the documented long-context multipliers for its
 * entire usage; never infer those buckets from aggregate totals.
 */
export function calculateGpt6CostUsdFromBuckets(
  model: string | undefined,
  usage: Gpt6UsageBuckets
): number | null {
  const units = calculateUsageBucketsCostUnits(model, usage)
  return units === null ? null : units / USD_COST_UNITS_PER_DOLLAR
}

export function calculateGpt6CostUsdFromModelBuckets(
  usageByModel: Gpt6ModelUsageBuckets[]
): number | null {
  if (usageByModel.length === 0 || usageByModel.length > 3) return null
  let totalUnits = 0
  for (const usage of usageByModel) {
    const units = calculateUsageBucketsCostUnits(usage.model, usage)
    if (units === null) return null
    totalUnits += units
    if (!Number.isSafeInteger(totalUnits)) return null
  }
  return totalUnits / USD_COST_UNITS_PER_DOLLAR
}

/**
 * Returns a rate-card breakdown and an uncached-input counterfactual from the
 * same validated per-model buckets. This is an estimate, not invoice evidence
 * or a causal savings claim. Long-context multipliers are applied per bucket.
 */
export function calculateGpt6CostBreakdownFromModelBuckets(usageByModel: Gpt6ModelUsageBuckets[]): {
  standardInputUsd: number
  cachedInputReadUsd: number
  cacheWriteInputUsd: number
  outputUsd: number
  actualRateCardCostUsd: number
  uncachedCounterfactualUsd: number
  netCacheSavingsUsd: number
} | null {
  if (usageByModel.length === 0 || usageByModel.length > 3) return null
  let standardInput = 0
  let cachedInputRead = 0
  let cacheWriteInput = 0
  let output = 0
  let uncachedCounterfactual = 0
  for (const usage of usageByModel) {
    const rate = resolveRate(usage.model)
    const values = [
      usage.standardInputTokens,
      usage.standardCachedInputTokens,
      usage.standardCacheWriteInputTokens,
      usage.standardOutputTokens,
      usage.longInputTokens,
      usage.longCachedInputTokens,
      usage.longCacheWriteInputTokens,
      usage.longOutputTokens,
    ]
    if (
      !rate ||
      values.some((value) => value === null || !Number.isSafeInteger(value) || value < 0)
    ) {
      return null
    }
    if (
      !hasValidCacheBuckets(
        usage.standardInputTokens!,
        usage.standardCachedInputTokens!,
        usage.standardCacheWriteInputTokens!
      ) ||
      !hasValidCacheBuckets(
        usage.longInputTokens!,
        usage.longCachedInputTokens!,
        usage.longCacheWriteInputTokens!
      )
    ) {
      return null
    }
    const standard = calculateBucketCostBreakdownUnits(
      rate,
      usage.standardInputTokens!,
      usage.standardCachedInputTokens!,
      usage.standardCacheWriteInputTokens!,
      usage.standardOutputTokens!,
      1
    )
    const long = calculateBucketCostBreakdownUnits(
      rate,
      usage.longInputTokens!,
      usage.longCachedInputTokens!,
      usage.longCacheWriteInputTokens!,
      usage.longOutputTokens!,
      2
    )
    standardInput += standard.standardInput + long.standardInput
    cachedInputRead += standard.cachedInputRead + long.cachedInputRead
    cacheWriteInput += standard.cacheWriteInput + long.cacheWriteInput
    output += standard.output + long.output
    uncachedCounterfactual += standard.uncachedCounterfactual + long.uncachedCounterfactual
    if (
      ![standardInput, cachedInputRead, cacheWriteInput, output, uncachedCounterfactual].every(
        Number.isSafeInteger
      )
    ) {
      return null
    }
  }
  const actual = standardInput + cachedInputRead + cacheWriteInput + output
  if (!Number.isSafeInteger(actual)) return null
  return {
    standardInputUsd: standardInput / USD_COST_UNITS_PER_DOLLAR,
    cachedInputReadUsd: cachedInputRead / USD_COST_UNITS_PER_DOLLAR,
    cacheWriteInputUsd: cacheWriteInput / USD_COST_UNITS_PER_DOLLAR,
    outputUsd: output / USD_COST_UNITS_PER_DOLLAR,
    actualRateCardCostUsd: actual / USD_COST_UNITS_PER_DOLLAR,
    uncachedCounterfactualUsd: uncachedCounterfactual / USD_COST_UNITS_PER_DOLLAR,
    netCacheSavingsUsd: (uncachedCounterfactual - actual) / USD_COST_UNITS_PER_DOLLAR,
  }
}

export function calculateGpt6CostUsd(
  model: string | undefined,
  usage: {
    inputTokens: number | null
    cachedInputTokens: number | null
    cacheWriteInputTokens?: number | null
    outputTokens: number | null
  }
): number | null {
  const rate = resolveRate(model)
  if (
    !rate ||
    usage.inputTokens === null ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens === null ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.cachedInputTokens === null ||
    !Number.isSafeInteger(usage.cachedInputTokens) ||
    usage.cachedInputTokens < 0 ||
    (usage.cacheWriteInputTokens != null &&
      (!Number.isSafeInteger(usage.cacheWriteInputTokens) || usage.cacheWriteInputTokens < 0)) ||
    usage.cachedInputTokens + (usage.cacheWriteInputTokens ?? 0) > usage.inputTokens
  ) {
    return null
  }
  // Long-context pricing applies to an individual request. Aggregate totals
  // cannot reveal which requests exceeded the threshold, so calculating from
  // them would produce a made-up number.
  if (usage.inputTokens > GPT_6_LONG_CONTEXT_THRESHOLD_TOKENS) return null
  const costUnits = calculateBucketCostUnits(
    rate,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens ?? 0,
    usage.outputTokens,
    1
  )
  return Number.isSafeInteger(costUnits) ? costUnits / USD_COST_UNITS_PER_DOLLAR : null
}
