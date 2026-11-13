import { isValidElement, type ReactElement, type ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const reset = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const i = hooks.cursor++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial
    return [
      hooks.values[i],
      (v: unknown) => {
        hooks.values[i] = v
      },
    ]
  },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=synthetic-one-time-token"),
}))
vi.mock("@lyrashield/auth", () => ({
  authClient: { resetPassword: reset },
  getAuthErrorMessage: () => null,
}))
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }))
import ResetPasswordPage from "./page"
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function render() {
  hooks.cursor = 0
  return elements(ResetPasswordPage())
}
beforeEach(() => {
  hooks.values = []
  vi.clearAllMocks()
})
it("confirms password reset accessibly without retaining or forwarding the one-time token", async () => {
  reset.mockResolvedValue({ error: null })
  const form = render().find((e) => e.type === "form")!
  await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({
    preventDefault() {},
  })
  const completed = render()
  expect(
    completed.some(
      (e) =>
        e.props.role === "status" &&
        String(e.props.children).includes("Password reset successfully")
    )
  ).toBe(true)
  expect(completed.some((e) => e.props.href === "/sign-in")).toBe(true)
  expect(completed.some((e) => e.type === "form")).toBe(false)
  expect(push).not.toHaveBeenCalled()
})
