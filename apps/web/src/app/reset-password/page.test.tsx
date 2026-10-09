import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ResetPasswordPage from "./page"

const query = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => query.token }),
}))
vi.mock("@lyrashield/auth", () => ({
  authClient: { resetPassword: vi.fn() },
  getAuthErrorMessage: () => null,
}))
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }))

describe("reset-link arrival state", () => {
  beforeEach(() => {
    query.token = null
  })

  it.each([null, ""])("does not request a password when token is %s", (token) => {
    query.token = token
    const html = renderToStaticMarkup(<ResetPasswordPage />)
    expect(html).toContain("This reset link is invalid or has expired")
    expect(html).toContain('href="/forgot-password"')
    expect(html).not.toContain('id="password"')
    expect(html).not.toContain('type="submit"')
  })

  it("retains the password form for a supplied token without asserting that it is valid", () => {
    query.token = ["synthetic", "test", "token"].join("-")
    const html = renderToStaticMarkup(<ResetPasswordPage />)
    expect(html).toContain('id="password"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('minLength="8"')
  })
})
