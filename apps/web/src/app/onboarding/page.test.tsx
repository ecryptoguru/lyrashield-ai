import type { ReactElement } from "react"
import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ state: vi.fn(), choices: vi.fn(), update: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: async () => ({ userId: "browser-user", userName: "Example" }),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { onboardingState: { update: mocks.update } },
  withWorkspaceRLS: async () => null,
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(path)
  },
}))
vi.mock("@/lib/onboarding-state", () => ({ getOrCreateOnboardingState: mocks.state }))
vi.mock("@/lib/onboarding-workspace", () => ({ listOnboardingWorkspaces: mocks.choices }))
vi.mock("@/lib/account-acquisition", () => ({ claimAccountAcquisition: async () => null }))
vi.mock("@/lib/analytics-preference", () => ({ analyticsAllowedForRequest: async () => true }))
vi.mock("./onboarding-wizard", () => ({ OnboardingWizard: () => null }))
vi.mock("./referral-claim", () => ({ ReferralClaim: () => null }))
vi.mock("./sign-out-button", () => ({ SignOutButton: () => null }))
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/components/invitation-accept-bridge", () => ({ InvitationAcceptBridge: () => null }))
import Page from "./page"
import { OnboardingWizard } from "./onboarding-wizard"
import type { OnboardingWizardProps } from "./onboarding-wizard-model"
const initial = {
  id: "state",
  userId: "browser-user",
  updatedAt: new Date("2026-10-30T00:00:00Z"),
  currentStep: 1,
  completed: false,
  skipped: false,
  workspaceId: null,
  targetId: null,
  selectedGoal: null,
  buildTool: null,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.mockResolvedValue(initial)
  mocks.choices.mockResolvedValue([
    { id: "ws-first", name: "Alpha", role: "OWNER" },
    { id: "ws-picked", name: "Beta", role: "DEVELOPER" },
  ])
})
async function wizardProps() {
  const tree = await Page({ searchParams: Promise.resolve({}) })
  const children = tree.props.children as ReactElement<OnboardingWizardProps>[]
  return children.find((child) => child?.type === OnboardingWizard)!.props
}
it("lists eligible workspace names and roles without selecting the first membership", async () => {
  const props = await wizardProps()
  expect(props.initialState.workspaceId).toBeNull()
  expect(props.workspaceChoices).toEqual([
    { id: "ws-first", name: "Alpha", role: "OWNER" },
    { id: "ws-picked", name: "Beta", role: "DEVELOPER" },
  ])
  expect(mocks.update).not.toHaveBeenCalled()
})
it("preserves a valid explicit selection and in-progress goal", async () => {
  mocks.state.mockResolvedValue({
    ...initial,
    workspaceId: "ws-picked",
    selectedGoal: "LAUNCH_REVIEW",
    currentStep: 2,
  })
  const props = await wizardProps()
  expect(props.initialState).toMatchObject({
    workspaceId: "ws-picked",
    selectedGoal: "LAUNCH_REVIEW",
    currentStep: 2,
  })
  expect(mocks.update).not.toHaveBeenCalled()
})
it("returns to the chooser when a selected workspace is deleted, inactive or no longer eligible", async () => {
  mocks.state.mockResolvedValue({
    ...initial,
    workspaceId: "ws-unavailable",
    targetId: "old-target",
  })
  const props = await wizardProps()
  expect(props.initialState).toMatchObject({ workspaceId: null, targetId: null, currentStep: 1 })
  expect(mocks.update).not.toHaveBeenCalled()
})

it("renders a missing target as incomplete without overwriting concurrent persisted progress", async () => {
  mocks.update.mockResolvedValue({ ...initial, workspaceId: "ws-picked", currentStep: 1 })
  mocks.state.mockResolvedValue({
    ...initial,
    workspaceId: "ws-picked",
    targetId: "missing-target",
    currentStep: 3,
  })
  const props = await wizardProps()
  expect(props.initialState).toMatchObject({
    workspaceId: "ws-picked",
    targetId: null,
    currentStep: 1,
  })
  expect(mocks.update).not.toHaveBeenCalled()
})
