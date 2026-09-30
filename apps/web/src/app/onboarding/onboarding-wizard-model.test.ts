import { expect, it } from "vitest"
import { initialOnboardingSelection } from "./onboarding-wizard-model"

it("uses an arrival hint only before onboarding has progressed", () => {
  const initialState = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
  }

  expect(initialOnboardingSelection(initialState, "url")).toEqual({ path: "url", step: 3 })
  expect(
    initialOnboardingSelection(
      { ...initialState, currentStep: 2, targetId: "target-1", targetType: "REPO" },
      "api"
    )
  ).toEqual({ path: "github", step: 2 })
  expect(initialOnboardingSelection({ ...initialState, currentStep: 0 })).toEqual({
    path: null,
    step: 1,
  })
})
