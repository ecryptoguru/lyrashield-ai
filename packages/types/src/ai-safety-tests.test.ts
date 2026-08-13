import { describe, expect, it } from "vitest"
import { isSafetyCaseAllowed, LiveAiSafetyPlanSchema } from "./ai-safety-tests"

describe("AI safety test contract", () => {
  it("rejects a live test plan without endpoint and authorization", () => {
    expect(
      LiveAiSafetyPlanSchema.safeParse({ workspaceId: "ws", targetId: "target", cases: [] }).success
    ).toBe(false)
  })

  it("does not permit destructive cases under the non-destructive beta policy", () => {
    expect(isSafetyCaseAllowed({ destructive: true }, { destructiveTestsAllowed: false })).toBe(
      false
    )
  })
})
