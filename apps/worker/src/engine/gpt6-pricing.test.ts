import { describe, expect, it } from "vitest"
import {
  calculateGpt6CostBreakdownFromModelBuckets,
  calculateGpt6CostUsd,
  calculateGpt6CostUsdFromBuckets,
  calculateGpt6CostUsdFromModelBuckets,
  GPT_6_PRICING_USD_PER_MILLION,
  sumUsdCosts,
  usdCostsMatch,
} from "./gpt6-pricing"

describe("GPT-6 pricing", () => {
  it("reports read, write, output, and uncached counterfactual costs without hiding write premiums", () => {
    const breakdown = calculateGpt6CostBreakdownFromModelBuckets([
      {
        model: "azure_ai/gpt-6-luna",
        standardInputTokens: 1_000_000,
        standardCachedInputTokens: 0,
        standardCacheWriteInputTokens: 1_000_000,
        standardOutputTokens: 1_000,
        longInputTokens: 0,
        longCachedInputTokens: 0,
        longCacheWriteInputTokens: 0,
        longOutputTokens: 0,
      },
    ])

    expect(breakdown).toEqual({
      standardInputUsd: 0,
      cachedInputReadUsd: 0,
      cacheWriteInputUsd: 0.125,
      outputUsd: 0.0005,
      actualRateCardCostUsd: 0.1255,
      uncachedCounterfactualUsd: 0.1005,
      netCacheSavingsUsd: -0.025,
    })
  })

  it("applies long-context multipliers and refuses incomplete model buckets", () => {
    const usage = {
      model: "gpt-6-sol",
      standardInputTokens: 0,
      standardCachedInputTokens: 0,
      standardCacheWriteInputTokens: 0,
      standardOutputTokens: 0,
      longInputTokens: 1_000_000,
      longCachedInputTokens: 1_000_000,
      longCacheWriteInputTokens: 0,
      longOutputTokens: 1_000,
    }
    expect(calculateGpt6CostBreakdownFromModelBuckets([usage])).toEqual({
      standardInputUsd: 0,
      cachedInputReadUsd: 0.4,
      cacheWriteInputUsd: 0,
      outputUsd: 0.015,
      actualRateCardCostUsd: 0.415,
      uncachedCounterfactualUsd: 4.015,
      netCacheSavingsUsd: 3.6,
    })
    expect(
      calculateGpt6CostBreakdownFromModelBuckets([
        { ...usage, longCachedInputTokens: null as unknown as number },
      ])
    ).toBeNull()
  })

  it("tracks Sol and Luna read/write rates separately", () => {
    expect(GPT_6_PRICING_USD_PER_MILLION).toEqual({
      "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
      "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
    })
    expect(
      calculateGpt6CostUsd("azure_ai/gpt-6-luna", {
        inputTokens: 10_000,
        cachedInputTokens: 2_000,
        cacheWriteInputTokens: 3_000,
        outputTokens: 1_000,
      })
    ).toBe(0.001395)
  })

  it("fails closed for models outside the supported GPT-6 routes", () => {
    expect(
      calculateGpt6CostUsd("azure_ai/gpt-4o", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
  })

  it("rejects cache counters that exceed request input instead of capping them", () => {
    expect(
      calculateGpt6CostUsd("gpt-6-sol", {
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 30,
        outputTokens: 10,
      })
    ).toBeNull()

    const invalidBuckets = {
      model: "gpt-6-sol",
      standardInputTokens: 100,
      standardCachedInputTokens: 80,
      standardCacheWriteInputTokens: 30,
      standardOutputTokens: 10,
      longInputTokens: 0,
      longCachedInputTokens: 0,
      longCacheWriteInputTokens: 0,
      longOutputTokens: 0,
    }
    expect(calculateGpt6CostUsdFromBuckets("gpt-6-sol", invalidBuckets)).toBeNull()
    expect(calculateGpt6CostUsdFromModelBuckets([invalidBuckets])).toBeNull()
    expect(calculateGpt6CostBreakdownFromModelBuckets([invalidBuckets])).toBeNull()
  })

  it("applies long-context multipliers to every bucket of the request", () => {
    expect(
      calculateGpt6CostUsdFromBuckets("azure_ai/gpt-6-sol", {
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

  it("retains sub-micro costs across model buckets and ancillary charges", () => {
    const tinyModelTotal = calculateGpt6CostUsdFromModelBuckets([
      {
        model: "azure_ai/gpt-6-luna",
        standardInputTokens: 1,
        standardCachedInputTokens: 1,
        standardCacheWriteInputTokens: 0,
        standardOutputTokens: 0,
        longInputTokens: 0,
        longCachedInputTokens: 0,
        longCacheWriteInputTokens: 0,
        longOutputTokens: 0,
      },
      {
        model: "azure_ai/gpt-6-sol",
        standardInputTokens: 1,
        standardCachedInputTokens: 1,
        standardCacheWriteInputTokens: 0,
        standardOutputTokens: 0,
        longInputTokens: 0,
        longCachedInputTokens: 0,
        longCacheWriteInputTokens: 0,
        longOutputTokens: 0,
      },
    ])

    expect(tinyModelTotal).toBe(0.00000021)
    expect(sumUsdCosts(0.00015, 0.01)).toBe(0.01015)
    expect(usdCostsMatch(0.010150000000000001, 0.01015)).toBe(true)
    expect(usdCostsMatch(0.0101500001, 0.01015)).toBe(false)
  })
})
