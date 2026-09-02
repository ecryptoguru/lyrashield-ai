import type { ReactElement, ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
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
import { OnboardingWizard } from "./onboarding-wizard"

type Element = ReactElement<{
  children?: ReactNode
  id?: string
  value?: string
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void
  onSubmit?: (event: { preventDefault: () => void }) => void
}>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}
function render(targetType: string) {
  hooks.cursor = 0
  return elements(
    OnboardingWizard({
      initialState: {
        currentStep: 1,
        completed: false,
        skipped: false,
        workspaceId: "ws",
        targetId: null,
        selectedGoal: null,
        targetType,
        targetName: "Staging Site",
      },
    })
  )
}
beforeEach(() => {
  hooks.values = []
})

it.each(["WEB_APP", "API"])(
  "preserves the entered %s name when advancing to product details",
  (targetType) => {
    render(targetType).find((element) => element.props.id === "url-name")!.props.onChange!({
      target: { value: "My entered product name" },
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
    expect(
      render(targetType).find((element) => element.props.id === "product-name")?.props.value
    ).toBe("My entered product name")
  }
)
