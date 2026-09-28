import type { ReactElement, ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    hooks.values[index] ??= { current: initial }
    return hooks.values[index]
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value
      },
    ]
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }))
vi.mock("@/lib/api-client", () => ({
  apiGet: api.get,
  apiPost: api.post,
  apiPatch: api.patch,
  ApiError: class ApiError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
}))
import { OnboardingWizard } from "./onboarding-wizard"
import { OnboardingScanRecovery } from "./onboarding-scan-recovery"
import { Button } from "@lyrashield/ui"
import { getOnboardingReviewOptions } from "./onboarding-flow.utils"
import { apiPost, apiPatch } from "@/lib/api-client"
import {
  OnboardingAlerts,
  PathChooserView,
  RepoSelectView,
  StepProgress,
  TargetDetailsView,
  UrlTargetView,
} from "./onboarding-step-views"

type Element = ReactElement<{
  children?: ReactNode
  id?: string
  href?: string
  value?: string
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void
  onSubmit?: (event: { preventDefault: () => void }) => void
  onClick?: (...args: unknown[]) => unknown
}>

// Onboarding views are plain presentational functions (no hooks). Descend into
// exactly those so assertions still see the inputs they render; library
// components (Button/Input/etc.) stay opaque leaf elements.
const VIEW_COMPONENTS = new Set<unknown>([
  OnboardingAlerts,
  OnboardingScanRecovery,
  PathChooserView,
  RepoSelectView,
  StepProgress,
  TargetDetailsView,
  UrlTargetView,
])

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  const inner =
    typeof element.type === "function" && VIEW_COMPONENTS.has(element.type)
      ? (element.type as (props: unknown) => ReactNode)(element.props)
      : element.props.children
  return [element, ...elements(inner)]
}
function render(
  targetType: string,
  overrides: {
    currentStep?: number
    workspaceId?: string | null
    targetId?: string | null
    selectedGoal?: string | null
    targetName?: string | null
  } = {}
) {
  hooks.cursor = 0
  return elements(
    OnboardingWizard({
      principalId: "user-1",
      initialState: {
        currentStep: 1,
        completed: false,
        skipped: false,
        workspaceId: "ws",
        targetId: null,
        selectedGoal: null,
        targetType,
        targetName: "Staging Site",
        ...overrides,
      },
    })
  )
}
beforeEach(() => {
  hooks.values = []
  api.get.mockReset()
  api.get.mockResolvedValue({
    allowed: true,
    code: null,
    message: null,
    plan: "TRIAL",
    isTrial: true,
    remainingMinutes: 120,
  })
  api.post.mockReset()
  api.patch.mockReset()
  vi.unstubAllGlobals()
})

it.each(["WEB_APP", "API"])(
  "preserves the entered %s name through to target details (asked once)",
  (targetType) => {
    render(targetType).find((element) => element.props.id === "url-name")!.props.onChange!({
      target: { value: "My entered target name" },
    })
    render(targetType).find((element) => element.props.id === "url-input")!.props.onChange!({
      target: { value: "https://example.test" },
    })
    render(targetType).find((element) => element.props.id === "ownership-check")!.props.onChange!({
      target: { checked: true },
    })
    render(targetType).find((element) => element.type === "form")!.props.onSubmit!({
      preventDefault: vi.fn(),
    })
    // v16 3.1: the name is asked once. The details step confirms the entered
    // name (the name saved) instead of asking for it again in a second input.
    expect(
      render(targetType).find((element) => element.props.children === "My entered target name")
    ).toBeDefined()
    expect(
      render(targetType).find((element) => element.props.id === "product-name")
    ).toBeUndefined()
  }
)

it("continues through a failed eligibility preflight without passing the click event", () => {
  const onStart = vi.fn()
  const onStartTrial = vi.fn()
  const reviewOptions = getOnboardingReviewOptions("github")
  const tree = TargetDetailsView({
    eyebrow: "Step 3",
    path: "github",
    productName: "Project",
    onProductNameChange: vi.fn(),
    retryingExistingTarget: false,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: { status: "error" },
    targetId: null,
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart,
    onStartTrial,
  })
  const primary = elements(tree)
    .filter((element) => element.type === Button)
    .at(-1)

  primary?.props.onClick?.({ preventDefault: vi.fn() })

  expect(String(primary?.props.children)).toContain("Continue to start")
  expect(onStart).toHaveBeenCalledWith(true)
  expect(onStartTrial).not.toHaveBeenCalled()
})

it("shows and invokes the start-trial action for TRIAL_AVAILABLE", () => {
  const onStart = vi.fn()
  const onStartTrial = vi.fn()
  const reviewOptions = getOnboardingReviewOptions("github")
  const tree = TargetDetailsView({
    eyebrow: "Step 3",
    path: "github",
    productName: "Project",
    onProductNameChange: vi.fn(),
    retryingExistingTarget: false,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: {
      status: "ready",
      eligibility: {
        allowed: false,
        code: "TRIAL_AVAILABLE",
        message: "Start your 7-day trial to receive 60 agent-minutes.",
        plan: "FREE",
        isTrial: false,
        remainingMinutes: 0,
      },
    },
    targetId: null,
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart,
    onStartTrial,
  })
  const primary = elements(tree)
    .filter((element) => element.type === Button)
    .at(-1)

  primary?.props.onClick?.({ preventDefault: vi.fn() })

  expect(String(primary?.props.children)).toContain("Start your free trial")
  expect(onStartTrial).toHaveBeenCalledOnce()
  expect(onStart).not.toHaveBeenCalled()
})

it("renders the Agency plan as a human-readable onboarding label", () => {
  const reviewOptions = getOnboardingReviewOptions("github")
  const tree = TargetDetailsView({
    eyebrow: "Step 3",
    path: "github",
    productName: "Project",
    onProductNameChange: vi.fn(),
    retryingExistingTarget: true,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: {
      status: "ready",
      eligibility: {
        allowed: true,
        code: null,
        message: null,
        plan: "LAUNCH_ASSURANCE",
        isTrial: false,
        remainingMinutes: 4_500,
      },
    },
    targetId: "target-1",
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart: vi.fn(),
    onStartTrial: vi.fn(),
  })

  expect(elements(tree).some((element) => element.props.children === "Agency")).toBe(true)
})

it("keeps an accepted scan and retries only the onboarding save after its PATCH fails", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const initialState = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: "target-1",
    selectedGoal: "LAUNCH_REVIEW",
    targetType: "REPO",
    targetName: "My repo",
    updatedAt: "2026-09-27T00:00:00.000Z",
  }
  api.patch
    .mockRejectedValueOnce(new Error("completion write failed"))
    .mockResolvedValueOnce({ ...initialState, currentStep: 4, completed: true })
  api.post.mockResolvedValueOnce({ id: "scan-1", operationId: "operation-1" })

  const checkAvailability = () =>
    render("REPO", initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(api.get).toHaveBeenCalledOnce()
  expect(api.post).not.toHaveBeenCalled()
  const start = () =>
    render("REPO", initialState).find((element) =>
      String(element.props.children).includes("Start release check")
    )!.props.onClick!()
  await start()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const accepted = render("REPO", initialState)
  expect(
    accepted.some(
      (element) => element.props.children === "Your scan started; onboarding could not be saved."
    )
  ).toBe(true)
  expect(accepted.some((element) => element.props.href === "/dashboard/scans/scan-1")).toBe(true)

  await accepted.find((element) => element.props.children === "Retry saving onboarding")!.props
    .onClick!()

  expect(apiPost).toHaveBeenCalledOnce()
  expect(apiPost).toHaveBeenCalledWith(
    "/api/scans",
    { workspaceId: "ws-1", targetId: "target-1", goal: "LAUNCH_REVIEW", mode: expect.any(String) },
    expect.objectContaining({ headers: { "Idempotency-Key": expect.any(String) } })
  )
  expect(apiPatch).toHaveBeenCalledTimes(2)
  expect(vi.mocked(apiPatch).mock.calls[1]?.[1]).toMatchObject({ completed: true, currentStep: 4 })
})

it("retries an uncertain scan start with the same idempotency key", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const initialState = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: "target-1",
    selectedGoal: "LAUNCH_REVIEW",
    targetType: "REPO",
    targetName: "My repo",
    updatedAt: "2026-09-27T00:00:00.000Z",
  }
  api.patch
    .mockResolvedValueOnce(initialState)
    .mockResolvedValueOnce(initialState)
    .mockResolvedValueOnce({ ...initialState, currentStep: 4, completed: true })
  api.post
    .mockRejectedValueOnce(new Error("connection lost after submission"))
    .mockResolvedValueOnce({ id: "scan-2", operationId: "operation-2" })

  const checkAvailability = () =>
    render("REPO", initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const start = render("REPO", initialState).find((element) =>
    String(element.props.children).includes("Start release check")
  )!.props.onClick!
  await start()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const unresolved = render("REPO", initialState)
  expect(unresolved.some((element) => element.props.children === "Retry same details")).toBe(true)
  await unresolved.find((element) => element.props.children === "Retry same details")!.props
    .onClick!()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(apiPost).toHaveBeenCalledTimes(2)
  const firstKey = (vi.mocked(apiPost).mock.calls[0]?.[2] as { headers?: Record<string, string> })
    .headers?.["Idempotency-Key"]
  const retryKey = (vi.mocked(apiPost).mock.calls[1]?.[2] as { headers?: Record<string, string> })
    .headers?.["Idempotency-Key"]
  expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i)
  expect(retryKey).toBe(firstKey)
})
