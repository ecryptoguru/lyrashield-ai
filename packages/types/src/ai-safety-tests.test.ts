import { describe, expect, it } from "vitest"
import {
  AI_SAFETY_TEST_CATALOG,
  isSafetyCaseAllowed,
  LiveAiSafetyPlanSchema,
} from "./ai-safety-tests"

describe("AI safety test contract", () => {
  const basePlan = {
    workspaceId: "ws",
    targetId: "target",
    endpointUrl: "https://staging.example.com/safety",
    approvedHost: "staging.example.com",
    incidentContact: "security@example.com",
    authMode: "NO_AUTH" as const,
    maxRequests: 1,
    maxDurationSeconds: 60,
    maxResponseBytes: 1024,
    rawSampleStorage: "DISABLED" as const,
    destructiveTestsAllowed: false as const,
    cases: [AI_SAFETY_TEST_CATALOG[0]],
  }

  it("rejects a live test plan without a safe endpoint", () => {
    expect(
      LiveAiSafetyPlanSchema.safeParse({ workspaceId: "ws", targetId: "target", cases: [] }).success
    ).toBe(false)
  })

  it("allows no-sign-in testing without a credential", () => {
    expect(LiveAiSafetyPlanSchema.safeParse(basePlan).success).toBe(true)
  })

  it("requires credentials only when sign-in is selected", () => {
    expect(
      LiveAiSafetyPlanSchema.safeParse({ ...basePlan, authMode: "TEST_CREDENTIAL" }).success
    ).toBe(false)
    expect(
      LiveAiSafetyPlanSchema.safeParse({
        ...basePlan,
        authMode: "TEST_CREDENTIAL",
        credentialId: "credential-1",
      }).success
    ).toBe(true)
  })

  it("rejects an endpoint outside the approved host", () => {
    expect(
      LiveAiSafetyPlanSchema.safeParse({ ...basePlan, approvedHost: "other.example.com" }).success
    ).toBe(false)
  })

  it("rejects modified or over-budget safety cases", () => {
    expect(
      LiveAiSafetyPlanSchema.safeParse({
        ...basePlan,
        cases: [{ ...AI_SAFETY_TEST_CATALOG[0], fixtureId: "custom-fixture" }],
      }).success
    ).toBe(false)
    expect(LiveAiSafetyPlanSchema.safeParse({ ...basePlan, maxRequests: 2 }).success).toBe(false)
  })

  it("does not permit destructive cases under the non-destructive beta policy", () => {
    expect(isSafetyCaseAllowed({ destructive: true }, { destructiveTestsAllowed: false })).toBe(
      false
    )
  })
})
