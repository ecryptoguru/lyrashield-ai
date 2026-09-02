import type { ReactElement, ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"

// Render the component's element tree with controlled hooks; no DOM dependency.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const post = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
vi.mock("@/lib/api-client", () => ({ apiPost: post, ApiError: class extends Error {} }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
import { BillingActions } from "./billing-actions"

type Element = ReactElement<{
  children?: ReactNode
  onClick?: () => Promise<void>
  disabled?: boolean
  "aria-label"?: string
}>
function buttons(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(buttons)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Element
  return [...(element.type === "button" ? [element] : []), ...buttons(element.props.children)]
}
function render(purchasesAvailable = true, plan = "FREE") {
  hooks.cursor = 0
  return buttons(
    BillingActions({
      plan,
      workspaceId: "ws",
      isLaunchAssurance: false,
      purchasesAvailable,
      trialAvailable: true,
    })
  )
}
beforeEach(() => {
  hooks.values = []
  vi.clearAllMocks()
})

it("blocks all checkout and trial actions while a request is pending, including stale clicks", async () => {
  let finish!: (value: unknown) => void
  post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const initial = render()
  const checkout = initial.find(
    (button) => button.props["aria-label"] === "Choose Pro, annual billing"
  )!
  const request = checkout.props.onClick!()
  expect(render().every((button) => button.props.disabled)).toBe(true)
  expect(
    render().find((button) => button.props["aria-label"] === "Choose Pro, annual billing")?.props
      .children
  ).toBe("Starting checkout…")
  await initial[0]!.props.onClick!()
  expect(post).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledWith("/billing/checkout", {
    workspaceId: "ws",
    plan: "PRO",
    interval: "annual",
  })
  finish({})
  await request
  expect(render().every((button) => !button.props.disabled)).toBe(true)
})

it.each(["STARTER", "PRO", "LAUNCH_ASSURANCE"])(
  "exposes no fresh-checkout handler for paid %s",
  (plan) => {
    expect(render(true, plan)).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
  }
)

it("starts a trial with purchase admission off and refreshes after success", async () => {
  post.mockResolvedValueOnce({ started: true })
  const actions = render(false)
  expect(actions).toHaveLength(1)
  await actions[0]!.props.onClick!()
  expect(post).toHaveBeenCalledWith("/api/billing/trial/start", { workspaceId: "ws" })
  expect(refresh).toHaveBeenCalledOnce()
})
