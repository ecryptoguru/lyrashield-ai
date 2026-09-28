import { expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

import { redirect } from "next/navigation"
import LegacyLoginPage from "./page"

it("redirects the legacy login path to sign-in", () => {
  LegacyLoginPage()
  expect(redirect).toHaveBeenCalledWith("/sign-in")
})
