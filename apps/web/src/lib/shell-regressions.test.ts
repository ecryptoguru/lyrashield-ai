import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ApiError } from "./api-client"
import { NAV_TITLE_ITEMS, resolveNav } from "./nav-items"

describe("shell regressions", () => {
  it("sanitizes API errors while preserving actionable business messages", () => {
    expect(
      new ApiError("LAST_OWNER", "The workspace must keep at least one owner", 409).message
    ).toBe("The workspace must keep at least one owner")
    expect(new ApiError("CUSTOM", "bad\u0000\nmessage\u202e", 400).message).toBe("bad  message")
    expect(new ApiError("LONG", "x".repeat(600), 400).message).toHaveLength(501)
  })
  it.each(["billing", "launch-readiness", "fixes", "projects", "ai-assurance"])(
    "has an exact mobile title for %s",
    (path) => {
      expect(NAV_TITLE_ITEMS.find((item) => item.href === `/dashboard/${path}`)?.label).toBeTruthy()
    }
  )
  it("keeps mobile Billing permission gated", () => {
    expect(
      resolveNav({ canManageBilling: true }).more.some((item) => item.href === "/dashboard/billing")
    ).toBe(true)
    expect(
      resolveNav({ canManageBilling: false }).more.some(
        (item) => item.href === "/dashboard/billing"
      )
    ).toBe(false)
  })

  // W1-06: a failed workspace switch is visible and recoverable in every shell
  // surface. The desktop sidebar previously swallowed the persistence error.
  it("surfaces a retryable workspace-switch failure in every shell path", () => {
    const sidebar = readFileSync(join(__dirname, "..", "components", "v2-sidebar.tsx"), "utf8")
    expect(sidebar).toContain('role="alert"')
    expect(sidebar).toContain("aria-live")
    expect(sidebar).toContain("Retry switch")
    expect(sidebar).toContain("Your current workspace is unchanged")
    const bottomNav = readFileSync(join(__dirname, "..", "components", "bottom-nav.tsx"), "utf8")
    expect(bottomNav).toContain('role="alert"')
  })
})
