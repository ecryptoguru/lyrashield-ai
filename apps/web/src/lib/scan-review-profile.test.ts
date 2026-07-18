import { describe, expect, it } from "vitest"
import { getScanReviewProfile } from "./scan-review-profile"

describe("getScanReviewProfile", () => {
  it("extracts the retained engine profile without exposing execution details", () => {
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
      ])
    ).toEqual({
      model: "review-model",
      reasoningEffort: "high",
    })
  })

  it("ignores malformed event metadata", () => {
    expect(
      getScanReviewProfile([{ stage: "engine_start", metadata: { model: 7, reasoningEffort: "" } }])
    ).toEqual({
      model: null,
      reasoningEffort: null,
    })
  })
})
