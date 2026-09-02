import { afterEach, describe, expect, it, vi } from "vitest"
import { parsePlanIntent, planIntentPath, rememberPlanIntent } from "./plan-intent"

afterEach(() => vi.unstubAllGlobals())

describe("plan intent", () => {
  it("retains validated selection for onboarding reloads without accepting arbitrary cookie values", () => {
    const document = { cookie: "" }
    vi.stubGlobal("document", document)
    vi.stubGlobal("window", { location: { protocol: "https:" } })
    rememberPlanIntent("PRO")
    expect(document.cookie).toBe(
      "lyrashield-plan-intent=PRO; Path=/; Max-Age=86400; SameSite=Lax; Secure"
    )
    document.cookie = ""
    rememberPlanIntent("PRO; Domain=evil.example")
    expect(document.cookie).toBe("")
  })
  it.each(["STARTER", "PRO", "LAUNCH_ASSURANCE"])(
    "carries %s only to fixed local destinations",
    (plan) => {
      expect(planIntentPath("/onboarding", plan)).toBe(`/onboarding?plan=${plan}`)
      expect(planIntentPath("/dashboard/billing", plan)).toBe(`/dashboard/billing?plan=${plan}`)
    }
  )
  it.each([
    "https://evil.example",
    "//evil.example",
    "PRO&redirect=//evil.example",
    "TEAM",
    "TRIAL",
    ["PRO"],
    null,
  ])("rejects invalid selection %s", (input) => {
    expect(parsePlanIntent(input)).toBeNull()
    expect(planIntentPath("/onboarding", input)).toBe("/onboarding")
  })
})
