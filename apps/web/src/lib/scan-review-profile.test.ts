import { describe, expect, it } from "vitest"
import { getScanReviewProfile } from "./scan-review-profile"

describe("getScanReviewProfile", () => {
  it("extracts the retained engine and budget profile without exposing execution details", () => {
    expect(
      getScanReviewProfile([
        {
          stage: "engine_start",
          metadata: {
            model: "review-model",
            reasoningEffort: "high",
            executable: "/private/engine",
            args: ["--secret"],
          },
        },
        { stage: "budget_cap", metadata: { maxBudgetUsd: 15, source: "mode_default" } },
      ])
    ).toEqual({
      model: "review-model",
      reasoningEffort: "high",
      maxBudgetUsd: 15,
      budgetSource: "mode_default",
    })
  })

  it("ignores malformed event metadata", () => {
    expect(
      getScanReviewProfile([
        { stage: "engine_start", metadata: { model: 7, reasoningEffort: "" } },
        { stage: "budget_cap", metadata: { maxBudgetUsd: -1, source: null } },
      ])
    ).toEqual({
      model: null,
      reasoningEffort: null,
      maxBudgetUsd: null,
      budgetSource: null,
    })
  })
})
