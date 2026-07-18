export const GPT_56_PRICING_EFFECTIVE_DATE = "2026-07-09"
export const GPT_56_PRICING_SOURCE = "https://openai.com/index/gpt-5-6/"
export const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000

export const GPT_56_PRICING_USD_PER_MILLION = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, cacheWriteInput: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 6 },
} as const

export type Gpt56UsageBuckets = {
  standardInputTokens: number | null
  standardCachedInputTokens: number | null
  standardCacheWriteInputTokens: number | null
  standardOutputTokens: number | null
  longInputTokens: number | null
  longCachedInputTokens: number | null
  longCacheWriteInputTokens: number | null
  longOutputTokens: number | null
}

function resolveRate(model: string | undefined) {
  const modelId = model?.trim().toLowerCase().split("/").pop()
  return modelId
    ? GPT_56_PRICING_USD_PER_MILLION[modelId as keyof typeof GPT_56_PRICING_USD_PER_MILLION]
    : undefined
}

function calculateBucketCost(
  rate: (typeof GPT_56_PRICING_USD_PER_MILLION)[keyof typeof GPT_56_PRICING_USD_PER_MILLION],
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  multiplier: number
) {
  const cached = Math.min(cachedInputTokens, inputTokens)
  const cacheWrite = Math.min(cacheWriteInputTokens, inputTokens - cached)
  const uncached = inputTokens - cached - cacheWrite
  return (
    uncached * rate.input * multiplier +
    cached * rate.cachedInput * multiplier +
    cacheWrite * rate.cacheWriteInput * multiplier +
    outputTokens * rate.output * (multiplier === 1 ? 1 : 1.5)
  )
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
  const rate = resolveRate(model)
  if (!rate || Object.values(usage).some((value) => value === null || value < 0)) return null
  const cost =
    calculateBucketCost(
      rate,
      usage.standardInputTokens!,
      usage.standardCachedInputTokens!,
      usage.standardCacheWriteInputTokens!,
      usage.standardOutputTokens!,
      1
    ) +
    calculateBucketCost(
      rate,
      usage.longInputTokens!,
      usage.longCachedInputTokens!,
      usage.longCacheWriteInputTokens!,
      usage.longOutputTokens!,
      2
    )
  return Math.round((cost / 1_000_000) * 1_000_000) / 1_000_000
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
  if (!rate || usage.inputTokens === null || usage.outputTokens === null) return null
  // Long-context pricing applies to an individual request. Aggregate totals
  // cannot reveal which requests exceeded the threshold, so calculating from
  // them would produce a made-up number.
  if (usage.inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS) return null
  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const cacheWriteInputTokens = Math.min(
    usage.cacheWriteInputTokens ?? 0,
    usage.inputTokens - cachedInputTokens
  )
  const uncachedInputTokens = usage.inputTokens - cachedInputTokens - cacheWriteInputTokens
  const cost =
    (uncachedInputTokens * rate.input +
      cachedInputTokens * rate.cachedInput +
      cacheWriteInputTokens * rate.cacheWriteInput +
      usage.outputTokens * rate.output) /
    1_000_000

  return Math.round(cost * 1_000_000) / 1_000_000
}
