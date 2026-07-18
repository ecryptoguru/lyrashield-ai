export const GPT_56_PRICING_EFFECTIVE_DATE = "2026-07-09"
export const GPT_56_PRICING_SOURCE = "https://openai.com/index/gpt-5-6/"
export const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000

export const GPT_56_PRICING_USD_PER_MILLION = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, cacheWriteInput: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 6 },
} as const

export function calculateGpt56CostUsd(
  model: string | undefined,
  usage: {
    inputTokens: number | null
    cachedInputTokens: number | null
    outputTokens: number | null
  }
): number | null {
  const modelId = model?.trim().toLowerCase().split("/").pop()
  const rate = modelId
    ? GPT_56_PRICING_USD_PER_MILLION[modelId as keyof typeof GPT_56_PRICING_USD_PER_MILLION]
    : undefined
  if (!rate || usage.inputTokens === null || usage.outputTokens === null) return null
  // Aggregate usage cannot reveal whether one request crossed the long-context
  // threshold, where the official input/output multipliers change.
  if (usage.inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS) return null

  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const uncachedInputTokens = usage.inputTokens - cachedInputTokens
  const cost =
    (uncachedInputTokens * rate.input +
      cachedInputTokens * rate.cachedInput +
      usage.outputTokens * rate.output) /
    1_000_000

  return Math.round(cost * 1_000_000) / 1_000_000
}
