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

  expect(initialOnboardingSelection(initialState, "url")).toEqual({ path: "url", step: 1 })
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

/**
 * P1-1 — a hinted, workspace-less user (the Lite Check handoff) must land on
 * step 1 with the path preselected, never on the details step. The details
 * step can create no workspace, so a hint that skipped to it left the user
 * with no way to start a scan.
 */
it("keeps a hinted, workspace-less user on step 1 with the path preselected", () => {
  const freshAccount = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
  }

  for (const hint of ["url", "api"] as const) {
    expect(initialOnboardingSelection(freshAccount, hint)).toEqual({ path: hint, step: 1 })
  }

  // The hint is still dropped once the user has a target or a target type.
  expect(
    initialOnboardingSelection(
      { ...freshAccount, targetType: "WEB_APP", targetId: "target-1" },
      "url"
    )
  ).toEqual({ path: "url", step: 1 })
})

it("preserves a persisted step beyond the first for a hinted user", () => {
  const resumed = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
  }

  expect(initialOnboardingSelection(resumed, "url")).toEqual({ path: "url", step: 3 })
})
