import { describe, it, expect } from "vitest"
import {
  OnboardingStepSchema,
  UpdateOnboardingSchema,
} from "./index"

describe("OnboardingStepSchema", () => {
  it("accepts all 7 valid step values", () => {
    const validSteps = ["WORKSPACE", "TARGET", "GOAL", "PREFLIGHT", "SCAN", "RESULTS", "FIX"]
    for (const step of validSteps) {
      expect(OnboardingStepSchema.safeParse(step).success).toBe(true)
    }
  })

  it("rejects invalid step value", () => {
    expect(OnboardingStepSchema.safeParse("INVALID").success).toBe(false)
  })

  it("rejects empty string", () => {
    expect(OnboardingStepSchema.safeParse("").success).toBe(false)
  })

  it("rejects lowercase", () => {
    expect(OnboardingStepSchema.safeParse("workspace").success).toBe(false)
  })
})

describe("UpdateOnboardingSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(UpdateOnboardingSchema.safeParse({}).success).toBe(true)
  })

  it("accepts valid currentStep in range 0-6", () => {
    for (let i = 0; i <= 6; i++) {
      expect(UpdateOnboardingSchema.safeParse({ currentStep: i }).success).toBe(true)
    }
  })

  it("rejects currentStep < 0", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: -1 }).success).toBe(false)
  })

  it("rejects currentStep > 6", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: 7 }).success).toBe(false)
  })

  it("rejects non-integer currentStep", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: 2.5 }).success).toBe(false)
  })

  it("accepts completed boolean", () => {
    expect(UpdateOnboardingSchema.safeParse({ completed: true }).success).toBe(true)
    expect(UpdateOnboardingSchema.safeParse({ completed: false }).success).toBe(true)
  })

  it("accepts skipped boolean", () => {
    expect(UpdateOnboardingSchema.safeParse({ skipped: true }).success).toBe(true)
    expect(UpdateOnboardingSchema.safeParse({ skipped: false }).success).toBe(true)
  })

  it("accepts workspaceId string", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: "ws-123" }).success).toBe(true)
  })

  it("accepts workspaceId null", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: null }).success).toBe(true)
  })

  it("accepts targetId string", () => {
    expect(UpdateOnboardingSchema.safeParse({ targetId: "tgt-456" }).success).toBe(true)
  })

  it("accepts targetId null", () => {
    expect(UpdateOnboardingSchema.safeParse({ targetId: null }).success).toBe(true)
  })

  it("accepts valid selectedGoal", () => {
    const validGoals = ["CHECK_PR", "TEST_APP", "LAUNCH_REVIEW", "WEEKLY_MONITOR", "FULL_PENTEST", "COMPLIANCE_REVIEW"]
    for (const goal of validGoals) {
      expect(UpdateOnboardingSchema.safeParse({ selectedGoal: goal }).success).toBe(true)
    }
  })

  it("accepts selectedGoal null", () => {
    expect(UpdateOnboardingSchema.safeParse({ selectedGoal: null }).success).toBe(true)
  })

  it("rejects invalid selectedGoal", () => {
    expect(UpdateOnboardingSchema.safeParse({ selectedGoal: "INVALID_GOAL" }).success).toBe(false)
  })

  it("accepts full valid update", () => {
    const update = {
      currentStep: 3,
      completed: false,
      skipped: false,
      workspaceId: "ws-abc",
      targetId: "tgt-xyz",
      selectedGoal: "CHECK_PR",
    }
    expect(UpdateOnboardingSchema.safeParse(update).success).toBe(true)
  })

  it("rejects non-boolean completed", () => {
    expect(UpdateOnboardingSchema.safeParse({ completed: "yes" }).success).toBe(false)
  })

  it("rejects non-string workspaceId", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: 123 }).success).toBe(false)
  })
})
