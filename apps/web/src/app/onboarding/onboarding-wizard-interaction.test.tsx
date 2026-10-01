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
  OnboardingStepSection,
  PathChooserView,
  RepoSelectView,
  StepProgress,
  TargetDetailsView,
  UrlTargetView,
  type Repo,
} from "./onboarding-step-views"

type Element = ReactElement<{
  children?: ReactNode
  id?: string
  href?: string
  value?: string
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void
  onSubmit?: (event: { preventDefault: () => void }) => void
  onClick?: (...args: unknown[]) => unknown
  onSelectRepo?: (repo: Repo) => void
  onContinue?: () => void
  onBack?: () => void
  onChoosePath?: (path: string) => void
}>

// Onboarding views are plain presentational functions (no hooks). Descend into
// exactly those so assertions still see the inputs they render; library
// components (Button/Input/etc.) stay opaque leaf elements.
const VIEW_COMPONENTS = new Set<unknown>([
  OnboardingAlerts,
  OnboardingScanRecovery,
  OnboardingStepSection,
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

it("reuses a created target when the onboarding save fails", async () => {
  const initialState = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: null,
    selectedGoal: null,
    targetType: "API",
    targetName: "Production API",
  }
  api.post.mockResolvedValueOnce({ id: "target-created" })
  api.patch
    .mockRejectedValueOnce(new Error("onboarding save failed"))
    .mockResolvedValueOnce({ ...initialState, targetId: "target-created", currentStep: 3 })

  const setupApiTarget = () => {
    const details = render("API", initialState)
    details.find((element) => element.props.id === "url-input")!.props.onChange!({
      target: { value: "https://api.example.test" },
    })
    render("API", initialState).find((element) => element.props.id === "ownership-check")!.props
      .onChange!({ target: { checked: true } })
    render("API", initialState).find((element) => element.type === "form")!.props.onSubmit!({
      preventDefault: vi.fn(),
    })
  }
  const checkAvailability = () =>
    render("API", initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  setupApiTarget()
  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(api.post).toHaveBeenCalledOnce()
  expect(api.post).toHaveBeenCalledWith(
    "/api/targets",
    expect.objectContaining({ workspaceId: "ws-1", url: "https://api.example.test" }),
    expect.any(Object)
  )
  expect(api.patch).toHaveBeenCalledOnce()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(api.post).toHaveBeenCalledOnce()
  expect(api.patch).toHaveBeenCalledTimes(2)
  expect(api.patch).toHaveBeenLastCalledWith(
    "/api/onboarding",
    expect.objectContaining({ targetId: "target-created" }),
    expect.any(Object)
  )
})

/**
 * W2.3 — the GitHub install return. OnboardingState persists currentStep
 * (set to 2 before the OAuth redirect) but not the chosen path, so the
 * wizard restores with step 2 and path null. Confirming a repository must
 * re-bind the GitHub path: without it `pathNeedsRepo(null)` is false and the
 * start action falls into the URL/API payload check, which can never pass
 * — the user's first scan is blocked.
 */
it("creates a repository target after a GitHub install return (path restored)", async () => {
  const initialState = {
    currentStep: 2,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: null,
    selectedGoal: null,
    targetType: null,
    targetName: null,
  }
  api.post.mockResolvedValueOnce({ id: "target-repo" })
  api.patch.mockResolvedValueOnce({ ...initialState, targetId: "target-repo", currentStep: 3 })

  const repo = {
    id: 42,
    fullName: "acme/app",
    name: "app",
    owner: "acme",
    defaultBranch: "main",
    private: false,
    htmlUrl: "https://github.com/acme/app",
    installationId: "inst-1",
  }
  const repoSelect = () =>
    render(null, initialState).find((element) => element.type === RepoSelectView)

  repoSelect()!.props.onSelectRepo!(repo)
  await repoSelect()!.props.onContinue!()

  const checkAvailability = () =>
    render(null, initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(api.post).toHaveBeenCalledWith(
    "/api/targets",
    expect.objectContaining({
      workspaceId: "ws-1",
      type: "REPO",
      repoProvider: "github",
      repoOwner: "acme",
      repoName: "app",
    }),
    expect.any(Object)
  )
  expect(api.patch).toHaveBeenCalledWith(
    "/api/onboarding",
    expect.objectContaining({ targetId: "target-repo" }),
    expect.any(Object)
  )
})

/**
 * W2.3 — a returning session can carry a persisted targetId while sitting
 * back on the URL entry step (e.g. skip/finish later resets currentStep
 * without clearing the target). Re-entering a different URL must create the
 * matching target — reusing the stale id would scan the previous target
 * while the user sees the new URL.
 */
it("creates a fresh target instead of reusing a stale targetId after the URL changed", async () => {
  const initialState = {
    currentStep: 0,
    completed: false,
    skipped: true,
    workspaceId: "ws-1",
    targetId: "target-old",
    selectedGoal: null,
    targetType: "WEB_APP",
    targetName: "Old Site",
  }
  api.post.mockResolvedValueOnce({ id: "target-new" })
  api.patch.mockResolvedValue({ ...initialState, targetId: "target-new", currentStep: 3 })

  render("WEB_APP", initialState).find((element) => element.props.id === "url-input")!.props
    .onChange!({ target: { value: "https://new.example.test" } })
  render("WEB_APP", initialState).find((element) => element.props.id === "ownership-check")!.props
    .onChange!({ target: { checked: true } })
  render("WEB_APP", initialState).find((element) => element.type === "form")!.props.onSubmit!({
    preventDefault: vi.fn(),
  })

  const checkAvailability = () =>
    render("WEB_APP", initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(api.post).toHaveBeenCalledWith(
    "/api/targets",
    expect.objectContaining({ url: "https://new.example.test", type: "WEB_APP" }),
    expect.any(Object)
  )
  expect(api.patch).toHaveBeenCalledWith(
    "/api/onboarding",
    expect.objectContaining({ targetId: "target-new" }),
    expect.any(Object)
  )
})

/**
 * W2.3 — the mirrored guard: switching the chooser path after a target
 * exists must not reuse a target of a different type. A persisted WEB_APP
 * target can never serve an API review.
 */
it("does not reuse a WEB_APP target when the path switched to API", async () => {
  const initialState = {
    currentStep: 0,
    completed: false,
    skipped: true,
    workspaceId: "ws-1",
    targetId: "target-old",
    selectedGoal: null,
    targetType: "WEB_APP",
    targetName: "Old Site",
  }
  api.post.mockResolvedValueOnce({ id: "target-api" })
  api.patch.mockResolvedValue({ ...initialState, targetId: "target-api", currentStep: 3 })

  // Path restored as "url" from the persisted target type; the user goes back
  // to the chooser and switches to the API path.
  render("WEB_APP", initialState).find((element) => element.type === UrlTargetView)!.props.onBack!()
  render("WEB_APP", initialState).find((element) => element.type === PathChooserView)!.props
    .onChoosePath!("api")
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  render("WEB_APP", initialState).find((element) => element.props.id === "url-input")!.props
    .onChange!({ target: { value: "https://api.example.test" } })
  render("WEB_APP", initialState).find((element) => element.props.id === "ownership-check")!.props
    .onChange!({ target: { checked: true } })
  render("WEB_APP", initialState).find((element) => element.type === "form")!.props.onSubmit!({
    preventDefault: vi.fn(),
  })

  const checkAvailability = () =>
    render("WEB_APP", initialState).find((element) =>
      String(element.props.children).includes("Check availability")
    )!.props.onClick!()

  await checkAvailability()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(api.post).toHaveBeenCalledWith(
    "/api/targets",
    expect.objectContaining({ url: "https://api.example.test", type: "API" }),
    expect.any(Object)
  )
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
