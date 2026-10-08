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
import { ApiError, apiPost, apiPatch } from "@/lib/api-client"
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
import { TargetNameSection } from "./onboarding-target-name-section"

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
  TargetNameSection,
  UrlTargetView,
])

/**
 * W1/P2-2 names the primary action for the review it starts, so the label is
 * path-specific: "Start release check" on the repo path, "Start endpoint
 * review" on the API path and "Start surface review" on the web-app path. The
 * three target-reuse cases below previously looked for the repo path's label
 * while driving the API and web-app paths, so they searched for a button that
 * was never on screen. The label is asserted per path instead.
 */
const START_LABEL = {
  github: "Start release check",
  url: "Start surface review",
  api: "Start endpoint review",
} as const

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

/**
 * Visible text of a subtree. The primary action carries a decorative icon
 * before its label, so `props.children` is `[<icon/>, "Start release check"]`
 * and `String(children)` reads "[object Object],Start release check". Assert on
 * the text the user reads instead of on the child array's stringification.
 */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (!node || typeof node !== "object" || !("props" in node)) return ""
  return textOf((node as Element).props.children)
}
function render(
  targetType: string | null,
  overrides: {
    currentStep?: number
    workspaceId?: string | null
    targetId?: string | null
    selectedGoal?: string | null
    targetName?: string | null
  } = {},
  targetTypeHint: "url" | "api" | null = null
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
      targetTypeHint,
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
    hasFailedScanAttempt: false,
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

  expect(textOf(primary?.props.children)).toContain("Continue to start")
  expect(onStart).toHaveBeenCalledWith(true)
  expect(onStartTrial).not.toHaveBeenCalled()
})

// W1/P2-2: the button is named for the action from the first render. It used
// to read "Check availability" and needed a second click to start the scan.
it("names the primary action from the first render for every eligibility state", () => {
  const reviewOptions = getOnboardingReviewOptions("github")
  const label = (eligibility: Parameters<typeof TargetDetailsView>[0]["eligibility"]) => {
    const tree = TargetDetailsView({
      eyebrow: "Step 3",
      path: "github",
      productName: "Project",
      onProductNameChange: vi.fn(),
      retryingExistingTarget: false,
      hasFailedScanAttempt: false,
      reviewOptions,
      selectedReview: reviewOptions[0],
      eligibility,
      targetId: null,
      onSelectGoal: vi.fn(),
      loading: false,
      onBack: vi.fn(),
      onStart: vi.fn(),
      onStartTrial: vi.fn(),
    })
    return textOf(
      elements(tree)
        .filter((element) => element.type === Button)
        .at(-1)?.props.children
    )
  }

  expect(label({ status: "idle" })).toBe("Start release check")
  expect(label({ status: "checking" })).toBe("Start release check")
  expect(
    label({
      status: "ready",
      eligibility: {
        allowed: true,
        code: null,
        message: null,
        plan: "TRIAL",
        isTrial: true,
        remainingMinutes: 60,
      },
    })
  ).toBe("Start release check")
  // A refusal keeps the scan named: the button still starts it, and the server
  // is the authority. Only a claimable trial gets its own label.
  expect(
    label({
      status: "ready",
      eligibility: {
        allowed: false,
        code: "NO_MINUTES_REMAINING",
        message: "No minutes remain.",
        plan: "FREE",
        isTrial: false,
        remainingMinutes: 0,
      },
    })
  ).toBe("Start release check")
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
    hasFailedScanAttempt: false,
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

  expect(textOf(primary?.props.children)).toContain("Start your free trial")
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
    hasFailedScanAttempt: false,
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
  const startScan = () =>
    render("API", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes(START_LABEL.api)
    )!.props.onClick!()

  setupApiTarget()
  await startScan()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(api.post).toHaveBeenCalledWith(
    "/api/targets",
    expect.objectContaining({ workspaceId: "ws-1", url: "https://api.example.test" }),
    expect.any(Object)
  )
  expect(api.patch).toHaveBeenCalledOnce()

  // W1/P2-2: the second click continues the same one-click action. It must
  // reuse the target the first attempt created, not create a second one.
  await startScan()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  const targetCreates = vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/targets")
  expect(targetCreates).toHaveLength(1)
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

  const startScan = () =>
    render(null, initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes("Start release check")
    )!.props.onClick!()

  await startScan()
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

  const startScan = () =>
    render("WEB_APP", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes(START_LABEL.url)
    )!.props.onClick!()

  await startScan()
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

  const startScan = () =>
    render("WEB_APP", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes(START_LABEL.api)
    )!.props.onClick!()

  await startScan()
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

  const startScan = () =>
    render("REPO", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes("Start release check")
    )!.props.onClick!()

  await startScan()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  // W1/P2-2: one click reads eligibility and posts the scan in the same action.
  expect(api.get).toHaveBeenCalledOnce()
  expect(apiPost).toHaveBeenCalledOnce()
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

  const startScan = () =>
    render("REPO", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes("Start release check")
    )!.props.onClick!()

  // W1/P2-2: one click reads eligibility and posts the scan. The first post is
  // lost; the recovery surface then retries the SAME submission.
  await startScan()
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

it("uses a fresh key after the server proves the previous scan was not submitted", async () => {
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
  const refusal = new ApiError("SCAN_SERVICE_UNAVAILABLE", "Scanning is unavailable.", 503)
  refusal.details = { operationOutcome: "OPERATION_NOT_SUBMITTED" }
  api.post.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ id: "scan-2" })

  const startScan = () =>
    render("REPO", initialState).find(
      (element) =>
        element.type === Button && textOf(element.props.children).includes("Start release check")
    )!.props.onClick!()

  // W1/P2-2: one click reads eligibility and posts the scan. The server proved
  // this one was not submitted, so the next click takes a fresh key.
  await startScan()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(storage.size).toBe(0)
  expect(
    render("REPO", initialState).some((element) => element.props.children === "Retry same details")
  ).toBe(false)

  await startScan()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(apiPost).toHaveBeenCalledTimes(2)
  const firstKey = (vi.mocked(apiPost).mock.calls[0]?.[2] as { headers?: Record<string, string> })
    .headers?.["Idempotency-Key"]
  const retryKey = (vi.mocked(apiPost).mock.calls[1]?.[2] as { headers?: Record<string, string> })
    .headers?.["Idempotency-Key"]
  expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i)
  expect(retryKey).toMatch(/^[0-9a-f-]{36}$/i)
  expect(retryKey).not.toBe(firstKey)
})

it("does not start the trial again after trial activation succeeded but scan admission failed", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const review = getOnboardingReviewOptions("github")[0]!
  const initialState = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: "target-1",
    selectedGoal: review.goal,
    targetType: "REPO",
    targetName: "Project",
  }
  api.get.mockResolvedValue({
    allowed: false,
    code: "TRIAL_AVAILABLE",
    message: "Start your trial.",
    plan: "FREE",
    isTrial: false,
    remainingMinutes: 0,
  })
  api.patch.mockResolvedValue({ ...initialState, completed: true, currentStep: 4 })
  const refusedScan = new ApiError("SCAN_SERVICE_UNAVAILABLE", "Scan service unavailable.", 503)
  refusedScan.details = { operationOutcome: "OPERATION_NOT_SUBMITTED" }
  api.post
    .mockResolvedValueOnce({ started: true, trialEndsAt: "2026-10-09T00:00:00.000Z" })
    .mockRejectedValueOnce(refusedScan)
    .mockResolvedValueOnce({ id: "scan-2" })

  const click = async (label: string) => {
    const button = render("REPO", initialState).find(
      (element) => element.type === Button && textOf(element.props.children).includes(label)
    )
    expect(button, `expected button containing ${label}`).toBeDefined()
    await button!.props.onClick!()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  await click("Start release check")
  await click("Start your free trial")
  await click("Start your free trial")

  const trialStarts = vi
    .mocked(apiPost)
    .mock.calls.filter(([url]) => url === "/api/billing/trial/start")
  const scanStarts = vi.mocked(apiPost).mock.calls.filter(([url]) => url === "/api/scans")
  expect(trialStarts).toHaveLength(1)
  expect(scanStarts).toHaveLength(2)
})

it("rechecks eligibility after an unknown trial-start response before deciding to retry it", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const review = getOnboardingReviewOptions("github")[0]!
  const initialState = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: "target-1",
    selectedGoal: review.goal,
    targetType: "REPO",
    targetName: "Project",
  }
  api.get
    .mockResolvedValueOnce({
      allowed: false,
      code: "TRIAL_AVAILABLE",
      message: "Start your trial.",
      plan: "FREE",
      isTrial: false,
      remainingMinutes: 0,
    })
    .mockResolvedValueOnce({
      allowed: true,
      code: null,
      message: null,
      plan: "TRIAL",
      isTrial: true,
      remainingMinutes: 60,
    })
  api.patch.mockResolvedValue({ ...initialState, completed: true, currentStep: 4 })
  api.post
    .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "Network request failed", 0))
    .mockResolvedValueOnce({ started: true, trialEndsAt: "2026-10-09T00:00:00.000Z" })
    .mockResolvedValueOnce({ id: "scan-2" })

  const click = async (label: string) => {
    const button = render("REPO", initialState).find(
      (element) => element.type === Button && textOf(element.props.children).includes(label)
    )
    expect(button, `expected button containing ${label}`).toBeDefined()
    await button!.props.onClick!()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  await click("Start release check")
  await click("Start your free trial")
  await click("Start your free trial")

  expect(api.get).toHaveBeenCalledTimes(2)
  expect(
    render("REPO", initialState).some(
      (element) =>
        element.type === Button && textOf(element.props.children).includes("Start release check")
    )
  ).toBe(true)
  await click("Start release check")

  const trialStarts = vi
    .mocked(apiPost)
    .mock.calls.filter(([url]) => url === "/api/billing/trial/start")
  const scanStarts = vi.mocked(apiPost).mock.calls.filter(([url]) => url === "/api/scans")
  expect(trialStarts).toHaveLength(1)
  expect(scanStarts).toHaveLength(1)
})

it("retries trial activation only when refreshed eligibility still says it is available", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const review = getOnboardingReviewOptions("github")[0]!
  const initialState = {
    currentStep: 3,
    completed: false,
    skipped: false,
    workspaceId: "ws-1",
    targetId: "target-1",
    selectedGoal: review.goal,
    targetType: "REPO",
    targetName: "Project",
  }
  const trialAvailable = {
    allowed: false,
    code: "TRIAL_AVAILABLE",
    message: "Start your trial.",
    plan: "FREE",
    isTrial: false,
    remainingMinutes: 0,
  }
  api.get.mockResolvedValue(trialAvailable)
  api.patch.mockResolvedValue({ ...initialState, completed: true, currentStep: 4 })
  api.post
    .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "Network request failed", 0))
    .mockResolvedValueOnce({ started: true, trialEndsAt: "2026-10-09T00:00:00.000Z" })
    .mockResolvedValueOnce({ id: "scan-2" })

  const click = async (label: string) => {
    const button = render("REPO", initialState).find(
      (element) => element.type === Button && textOf(element.props.children).includes(label)
    )
    expect(button, `expected button containing ${label}`).toBeDefined()
    await button!.props.onClick!()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  await click("Start release check")
  await click("Start your free trial")
  await click("Start your free trial")

  expect(api.get).toHaveBeenCalledTimes(2)
  const trialStarts = vi
    .mocked(apiPost)
    .mock.calls.filter(([url]) => url === "/api/billing/trial/start")
  const scanStarts = vi.mocked(apiPost).mock.calls.filter(([url]) => url === "/api/scans")
  expect(trialStarts).toHaveLength(2)
  expect(scanStarts).toHaveLength(1)
})

/**
 * P1-1 — the Lite Check onboarding dead-end.
 *
 * A user who arrives from the Lite Check handoff carries a target-type hint
 * and has no workspace. Before the fix the hint sent them straight to the
 * details step, where the only workspace-creating call (`choosePath`) never
 * runs, so the start action stopped with "Workspace is required." Pressing
 * Back reached the URL form, but the target payload builder returns null while
 * workspaceId is null, so Continue reported "Enter a name and a valid URL to
 * continue." for a perfectly valid URL. Skip was the only way out and the user
 * never reached a first scan.
 *
 * The acceptance path below is the whole funnel: land on the hinted form,
 * submit a valid URL and reach a STARTED scan.
 */
it("takes a hinted, workspace-less user from the URL form to a started scan (P1-1)", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  // The fresh account: no workspace, no target, nothing progressed.
  const freshAccount = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
    targetType: null,
    targetName: null,
    updatedAt: "2026-09-27T00:00:00.000Z",
  }
  api.post.mockImplementation(async (url: string) => {
    if (url === "/api/workspaces") return { id: "ws-new", trialStarted: true }
    if (url === "/api/targets") return { id: "target-new" }
    if (url === "/api/scans") return { id: "scan-new" }
    throw new Error(`unexpected POST ${url}`)
  })
  api.patch.mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
    ...freshAccount,
    ...body,
  }))

  const tree = () => render(null, freshAccount, "url")

  // 1. The hinted user lands on the URL form (step 1), not the details step.
  expect(tree().find((element) => element.type === UrlTargetView)).toBeDefined()
  expect(tree().find((element) => element.type === TargetDetailsView)).toBeUndefined()

  // 2. They fill the form in and submit it.
  tree().find((element) => element.props.id === "url-name")!.props.onChange!({
    target: { value: "example.com" },
  })
  tree().find((element) => element.props.id === "url-input")!.props.onChange!({
    target: { value: "https://example.com" },
  })
  tree().find((element) => element.props.id === "ownership-check")!.props.onChange!({
    target: { checked: true },
  })
  await tree().find((element) => element.type === "form")!.props.onSubmit!({
    preventDefault: vi.fn(),
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  // The workspace was created on submit — not merely by visiting onboarding.
  expect(api.post).toHaveBeenCalledWith("/api/workspaces", expect.any(Object), expect.any(Object))
  // ...and the user reached the details step rather than an error card.
  const details = tree()
  expect(details.find((element) => element.type === TargetDetailsView)).toBeDefined()
  expect(details.some((element) => element.props.children === "Workspace is required.")).toBe(false)

  // 3. Starting the scan reaches a STARTED scan. The action is named for what it
  //    does from the first render and the one click checks eligibility and
  //    starts the scan (P2-2). P1-1 is the workspace this click had to create
  //    for a hinted, workspace-less user, so this case asserts the scan is
  //    started against the workspace and target the action just resolved.
  const start = tree().find((element) =>
    String(element.props.children).includes("Start surface review")
  )
  expect(start, "expected the start action on the first render").toBeDefined()
  await start!.props.onClick!()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  const scanStarts = vi.mocked(apiPost).mock.calls.filter(([url]) => url === "/api/scans")
  expect(scanStarts).toHaveLength(1)
  expect(scanStarts[0]?.[1]).toMatchObject({
    workspaceId: "ws-new",
    targetId: "target-new",
  })
  const started = tree()
  expect(started.some((element) => element.props.href === "/dashboard/scans/scan-new")).toBe(true)
})

it("does not create a second workspace or target when Continue is double-tapped (P1-1)", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  const freshAccount = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
    targetType: null,
    targetName: null,
    updatedAt: "2026-09-27T00:00:00.000Z",
  }
  let releaseWorkspace!: () => void
  const workspaceHeld = new Promise<void>((resolve) => {
    releaseWorkspace = resolve
  })
  let workspaceCalls = 0
  api.post.mockImplementation(async (url: string) => {
    if (url === "/api/workspaces") {
      workspaceCalls++
      await workspaceHeld
      return { id: "ws-new" }
    }
    if (url === "/api/targets") return { id: "target-new" }
    throw new Error(`unexpected POST ${url}`)
  })
  api.patch.mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
    ...freshAccount,
    ...body,
  }))

  const tree = () => render(null, freshAccount, "url")
  tree().find((element) => element.props.id === "url-name")!.props.onChange!({
    target: { value: "example.com" },
  })
  tree().find((element) => element.props.id === "url-input")!.props.onChange!({
    target: { value: "https://example.com" },
  })
  tree().find((element) => element.props.id === "ownership-check")!.props.onChange!({
    target: { checked: true },
  })

  const submit = tree().find((element) => element.type === "form")!.props.onSubmit!
  // Two taps before the first workspace call resolves.
  const first = submit({ preventDefault: vi.fn() })
  const second = submit({ preventDefault: vi.fn() })
  releaseWorkspace()
  await Promise.all([first, second])
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(workspaceCalls).toBe(1)
})

it("reports an invalid URL without creating a workspace (P1-1)", async () => {
  const freshAccount = {
    currentStep: 1,
    completed: false,
    skipped: false,
    workspaceId: null,
    targetId: null,
    selectedGoal: null,
    targetType: null,
    targetName: null,
  }
  api.post.mockResolvedValue({ id: "ws-new" })

  const tree = () => render(null, freshAccount, "url")
  tree().find((element) => element.props.id === "url-input")!.props.onChange!({
    target: { value: "https://example.com" },
  })
  // W2-02 prefills the name from the URL host on URL change, so the name must
  // be cleared afterwards — otherwise the form really is submittable and this
  // test would be asserting on a valid submit. Cleared last, the prefill does
  // not fire again and the form is genuinely incomplete.
  tree().find((element) => element.props.id === "url-name")!.props.onChange!({
    target: { value: "" },
  })
  tree().find((element) => element.props.id === "ownership-check")!.props.onChange!({
    target: { checked: true },
  })
  // The name is empty: the form is not submittable and no workspace is created.
  await tree().find((element) => element.type === "form")!.props.onSubmit!({
    preventDefault: vi.fn(),
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(api.post).not.toHaveBeenCalled()
  expect(
    tree().some((element) => element.props.children === "Enter a name and a valid URL to continue.")
  ).toBe(true)
})
