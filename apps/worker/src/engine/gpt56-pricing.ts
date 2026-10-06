export const GPT_56_PRICING_EFFECTIVE_DATE = "2026-08-06"
export const GPT_56_PRICING_SOURCE =
  "https://azure.microsoft.com/en-us/blog/gpt-5-6-now-available-in-microsoft-foundry/#gpt-5-6-pricing-for-sol-terra-and-luna"
const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const USD_COST_UNITS_PER_DOLLAR = 10_000_000_000
const USD_COST_UNITS_PER_RATE_TOKEN = USD_COST_UNITS_PER_DOLLAR / 1_000_000
export const GPT_6_PRICING_EFFECTIVE_DATE = "2026-09-22"
export const GPT_6_PRICING_SOURCE =
  "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"

export const GPT_56_PRICING_USD_PER_MILLION = {
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.2 },
} as const
export const GPT_6_PRICING_USD_PER_MILLION = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
} as const
const MODEL_PRICING_USD_PER_MILLION = {
  ...GPT_56_PRICING_USD_PER_MILLION,
  ...GPT_6_PRICING_USD_PER_MILLION,
}

type Gpt56UsageBuckets = {
  standardInputTokens: number | null
  standardCachedInputTokens: number | null
  standardCacheWriteInputTokens: number | null
  standardOutputTokens: number | null
  longInputTokens: number | null
  longCachedInputTokens: number | null
  longCacheWriteInputTokens: number | null
  longOutputTokens: number | null
}

export type Gpt56ModelUsageBuckets = Gpt56UsageBuckets & { model: string }

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

function calculateUsageBucketsCostUnits(
  model: string | undefined,
  usage: Gpt56UsageBuckets
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
export function calculateGpt56CostUsdFromBuckets(
  model: string | undefined,
  usage: Gpt56UsageBuckets
): number | null {
  const units = calculateUsageBucketsCostUnits(model, usage)
  return units === null ? null : units / USD_COST_UNITS_PER_DOLLAR
}

export function calculateGpt56CostUsdFromModelBuckets(
  usageByModel: Gpt56ModelUsageBuckets[]
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

export function calculateGpt56CostUsd(
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
      (!Number.isSafeInteger(usage.cacheWriteInputTokens) || usage.cacheWriteInputTokens < 0))
  ) {
    return null
  }
  // Long-context pricing applies to an individual request. Aggregate totals
  // cannot reveal which requests exceeded the threshold, so calculating from
  // them would produce a made-up number.
  if (usage.inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS) return null
  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens)
  const cacheWriteInputTokens = Math.min(
    usage.cacheWriteInputTokens ?? 0,
    usage.inputTokens - cachedInputTokens
  )
  const costUnits = calculateBucketCostUnits(
    rate,
    usage.inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    usage.outputTokens,
    1
  )
  return Number.isSafeInteger(costUnits) ? costUnits / USD_COST_UNITS_PER_DOLLAR : null
}
