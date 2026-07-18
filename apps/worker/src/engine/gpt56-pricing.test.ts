import { describe, expect, it } from "vitest"
import {
  calculateGpt56CostUsd,
  calculateGpt56CostUsdFromBuckets,
  GPT_56_PRICING_USD_PER_MILLION,
} from "./gpt56-pricing"

describe("GPT-5.6 official pricing", () => {
  it("stores the official Sol, Terra, and Luna rates", () => {
    expect(GPT_56_PRICING_USD_PER_MILLION).toEqual({
      "gpt-5.6-sol": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 },
      "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, cacheWriteInput: 3.125, output: 15 },
      "gpt-5.6-luna": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 6 },
    })
  })

  it.each([
    ["azure_ai/gpt-5.6-luna", 0.02679],
    ["azure_ai/gpt-5.6-terra", 0.066975],
    ["openai/gpt-5.6-sol", 0.13395],
  ])("calculates %s cost from uncached, cached, and output tokens", (model, expected) => {
    expect(
      calculateGpt56CostUsd(model, {
        inputTokens: 18_420,
        cachedInputTokens: 6_100,
        cacheWriteInputTokens: 0,
        outputTokens: 2_310,
      })
    ).toBe(expected)
  })

  it("accounts for explicit cache writes", () => {
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: 27_257,
        cachedInputTokens: 17_000,
        cacheWriteInputTokens: 10_000,
        outputTokens: 7_713,
      })
    ).toBe(0.060735)
  })

  it("applies long-context rates only to requests above 272k input tokens", () => {
    expect(
      calculateGpt56CostUsdFromBuckets("gpt-5.6-luna", {
        standardInputTokens: 100_000,
        standardCachedInputTokens: 20_000,
        standardCacheWriteInputTokens: 0,
        standardOutputTokens: 1_000,
        longInputTokens: 300_000,
        longCachedInputTokens: 100_000,
        longCacheWriteInputTokens: 0,
        longOutputTokens: 1_000,
      })
    ).toBe(0.517)
  })

  it("fails closed for unknown models or incomplete usage", () => {
    expect(
      calculateGpt56CostUsd("gpt-5.5", {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: 10,
      })
    ).toBeNull()
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: 272_001,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
  })
})
