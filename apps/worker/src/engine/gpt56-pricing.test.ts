import { describe, expect, it } from "vitest"
import {
  calculateGpt56CostUsd,
  calculateGpt56CostUsdFromBuckets,
  calculateGpt56CostUsdFromModelBuckets,
  GPT_6_PRICING_USD_PER_MILLION,
  GPT_56_PRICING_USD_PER_MILLION,
} from "./gpt56-pricing"

describe("GPT-5.6 official pricing", () => {
  it("stores the official Terra and Luna rates", () => {
    expect(GPT_56_PRICING_USD_PER_MILLION).toEqual({
      "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 },
      "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.2 },
    })
  })

  it.each([
    ["azure_ai/gpt-5.6-luna", 0.005358],
    ["azure_ai/gpt-5.6-terra", 0.05358],
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
    ).toBe(0.012147)
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
    ).toBe(0.1034)
  })

  it("prices a Terra coordinator and Luna delegates independently", () => {
    expect(
      calculateGpt56CostUsdFromModelBuckets([
        {
          model: "azure_ai/gpt-5.6-terra",
          standardInputTokens: 100_000,
          standardCachedInputTokens: 0,
          standardCacheWriteInputTokens: 0,
          standardOutputTokens: 1_000,
          longInputTokens: 0,
          longCachedInputTokens: 0,
          longCacheWriteInputTokens: 0,
          longOutputTokens: 0,
        },
        {
          model: "azure_ai/gpt-5.6-luna",
          standardInputTokens: 200_000,
          standardCachedInputTokens: 0,
          standardCacheWriteInputTokens: 0,
          standardOutputTokens: 2_000,
          longInputTokens: 0,
          longCachedInputTokens: 0,
          longCacheWriteInputTokens: 0,
          longOutputTokens: 0,
        },
      ])
    ).toBe(0.2544)
  })

  it("treats missing cache-write tokens as zero and fails closed for unknown models", () => {
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
      })
    ).toBe(0.000032)
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
        cacheWriteInputTokens: 0,
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
  })
})

describe("GPT-6 published pricing", () => {
  it("tracks Sol and Luna read/write rates separately", () => {
    expect(GPT_6_PRICING_USD_PER_MILLION).toEqual({
      "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
      "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
    })
    expect(
      calculateGpt56CostUsd("azure_ai/gpt-6-luna", {
        inputTokens: 10_000,
        cachedInputTokens: 2_000,
        cacheWriteInputTokens: 3_000,
        outputTokens: 1_000,
      })
    ).toBe(0.001395)
  })

  it("applies long-context multipliers to every bucket of the request", () => {
    expect(
      calculateGpt56CostUsdFromBuckets("azure_ai/gpt-6-sol", {
        standardInputTokens: 0,
        standardCachedInputTokens: 0,
        standardCacheWriteInputTokens: 0,
        standardOutputTokens: 0,
        longInputTokens: 300_000,
        longCachedInputTokens: 100_000,
        longCacheWriteInputTokens: 100_000,
        longOutputTokens: 2_000,
      })
    ).toBe(0.97)
  })
})
