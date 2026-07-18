import { describe, expect, it } from "vitest"
import { calculateGpt56CostUsd, GPT_56_PRICING_USD_PER_MILLION } from "./gpt56-pricing"

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
        outputTokens: 2_310,
      })
    ).toBe(expected)
  })

  it("fails closed for unknown models or incomplete usage", () => {
    expect(
      calculateGpt56CostUsd("gpt-5.5", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: 10,
      })
    ).toBeNull()
    expect(
      calculateGpt56CostUsd("gpt-5.6-luna", {
        inputTokens: 272_001,
        cachedInputTokens: 0,
        outputTokens: 10,
      })
    ).toBeNull()
  })
})
