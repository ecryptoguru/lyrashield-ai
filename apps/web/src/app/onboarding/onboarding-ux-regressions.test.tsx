import { expect, it, vi } from "vitest"
import { Button } from "@lyrashield/ui"
import {
  onboardingStepEyebrow,
  stepModelForPath,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import { PathChooserView, TargetDetailsView, UrlTargetView } from "./onboarding-step-views"
import { TargetNameSection } from "./onboarding-target-name-section"
import { getOnboardingReviewOptions } from "./onboarding-flow.utils"
import { useOnboardingNavigation } from "./use-onboarding-navigation"

type Element = {
  type: unknown
  props: { children?: unknown; [key: string]: unknown }
}

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textContent).join("")
  if (!node || typeof node !== "object" || !("props" in node)) return ""
  return textContent((node as Element).props.children)
}

it.each([
  [3, "url", "Step 2 of 2 · Target details"],
  [3, "api", "Step 2 of 2 · Target details"],
  [2, "github", "Step 2 of 3 · Select repository"],
] as const)("announces the visible onboarding step for %s/%s", (step, path, expected) => {
  expect(onboardingStepEyebrow(step, path)).toBe(expected)
})

it("keeps the first-step progress generic until a path is selected", () => {
  expect(onboardingStepEyebrow(1, null)).toBe("Step 1 of 2 · Add target")
  expect(stepModelForPath(null, 1).map((entry) => entry.label)).toEqual([
    "Add target",
    "Target details",
  ])
  expect(onboardingStepEyebrow(2, null)).toBe("Step 2 of 3 · Select repository")
})

it.each(["url", "api"] as const)(
  "leaves the %s target name empty for its placeholder",
  async (path) => {
    const setProductName = vi.fn()
    const params = {
      data: {
        currentStep: 1,
        completed: false,
        skipped: false,
        workspaceId: "workspace-1",
        targetId: null,
        selectedGoal: null,
      },
      completionPath: "/dashboard",
      productName: "",
      router: { push: vi.fn(), refresh: vi.fn() },
      connectGitHub: vi.fn(),
      ensureWorkspace: vi.fn(),
      persist: vi.fn(),
      setLoading: vi.fn(),
      setError: vi.fn(),
      setFailure: vi.fn(),
      setPath: vi.fn(),
      setProductName,
    }

    await useOnboardingNavigation(params).choosePath(path)

    expect(params.setPath).toHaveBeenCalledWith(path)
    expect(setProductName).not.toHaveBeenCalled()

    const view = UrlTargetView({
      eyebrow: onboardingStepEyebrow(1, path),
      path,
      productName: "",
      onProductNameChange: vi.fn(),
      url: "",
      ownershipAttested: false,
      onUrlChange: vi.fn(),
      onOwnershipChange: vi.fn(),
      loading: false,
      onBack: vi.fn(),
      onSubmit: vi.fn(),
    })
    const name = elements(view).find((element) => element.props.id === "url-name")
    expect(name?.props.value).toBe("")
    expect(name?.props.placeholder).toBe(path === "api" ? "Production API" : "Staging Site")
  }
)

it("uses a distinct API icon and keeps its path choice accessible", () => {
  const view = PathChooserView({
    eyebrow: "Step 1 of 3 · Add target",
    buildTool: null,
    onBuildTool: vi.fn(),
    loading: false,
    githubUnavailable: false,
    onChoosePath: vi.fn(),
  })
  const cards = elements(view).filter((element) => element.type === "button")
  const url = cards.find((card) => textContent(card).includes("Add an app URL"))
  const api = cards.find((card) => textContent(card).includes("Add an API"))
  const iconType = (card: Element | undefined) => {
    const children = card?.props.children
    return Array.isArray(children) ? (children[0] as Element | undefined)?.type : undefined
  }

  expect(url).toBeDefined()
  expect(api).toBeDefined()
  expect(iconType(api)).not.toBe(iconType(url))
})

it("shows retry wording only after a failed start and keeps Back available", () => {
  const reviewOptions = getOnboardingReviewOptions("url")
  const common = {
    eyebrow: "Step 2 of 2 · Target details",
    path: "url" as OnboardingPath,
    productName: "Staging Site",
    onProductNameChange: vi.fn(),
    retryingExistingTarget: true,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: { status: "idle" as const },
    targetId: "target-1",
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart: vi.fn(),
    onStartTrial: vi.fn(),
  }

  const beforeFailure = TargetDetailsView({ ...common, hasFailedScanAttempt: false })
  const afterFailure = TargetDetailsView({ ...common, hasFailedScanAttempt: true })
  const backButton = (view: unknown) =>
    elements(view).find(
      (element) => element.type === Button && textContent(element).trim() === "Back"
    )

  expect(textContent(beforeFailure)).not.toContain("Retry the review for")
  expect(textContent(afterFailure)).toContain("Retry the review for Staging Site")
  expect(backButton(beforeFailure)).toBeDefined()
  expect(backButton(afterFailure)).toBeDefined()
})

it("keeps target-detail copy specific to repository and URL setup", () => {
  const reviewOptions = getOnboardingReviewOptions("url")
  const common = {
    eyebrow: "Step 3 of 3 · Target details",
    productName: "Staging Site",
    onProductNameChange: vi.fn(),
    retryingExistingTarget: false,
    hasFailedScanAttempt: false,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: { status: "idle" as const },
    targetId: null,
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart: vi.fn(),
    onStartTrial: vi.fn(),
  }

  const repo = TargetDetailsView({ ...common, path: "github" })
  const url = TargetDetailsView({ ...common, path: "url" })

  expect(textContent(repo)).toContain(
    "Name your target. You can classify its environment later in target settings."
  )
  expect(textContent(url)).toContain(
    "Reviewing your web app. Confirm the details and choose what you need from this scan."
  )
})

it("keeps new repository names editable and persisted target names locked", () => {
  const reviewOptions = getOnboardingReviewOptions("github")
  const onProductNameChange = vi.fn()
  const common = {
    eyebrow: "Step 3 of 3 · Target details",
    path: "github" as const,
    productName: "Project",
    onProductNameChange,
    retryingExistingTarget: false,
    hasFailedScanAttempt: false,
    reviewOptions,
    selectedReview: reviewOptions[0],
    eligibility: { status: "idle" as const },
    targetId: "target-1",
    onSelectGoal: vi.fn(),
    loading: false,
    onBack: vi.fn(),
    onStart: vi.fn(),
    onStartTrial: vi.fn(),
  }

  const newRepository = TargetNameSection(common)
  const existingRepository = TargetNameSection({ ...common, retryingExistingTarget: true })
  const url = TargetNameSection({ ...common, path: "url" })

  expect(
    elements(newRepository).find((element) => element.props.id === "product-name")
  ).toMatchObject({
    props: { value: "Project", placeholder: "My web app" },
  })
  expect(textContent(existingRepository)).toContain("target details are locked")
  expect(elements(existingRepository).some((element) => element.props.id === "product-name")).toBe(
    false
  )
  expect(textContent(url)).toContain("Target nameProject")
  expect(elements(url).some((element) => element.props.id === "product-name")).toBe(false)
})
