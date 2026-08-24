import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const pricingPage = readFileSync(new URL("../pages/pricing.astro", import.meta.url), "utf8")

describe("pricing page", () => {
  it("renders cloud and Agency prices from the shared catalog with accessible toggle state", () => {
    expect(pricingPage).toContain("CLOUD_PLANS.filter((plan) => plan.selfServe)")
    expect(pricingPage).toContain('getPlan("AGENCY")')
    expect(pricingPage).not.toContain("const cloudPlans = [")
    expect(pricingPage).toContain("plan.price.usd.monthly")
    expect(pricingPage).toContain("agencyPlan.price.inr.monthly")
    expect(pricingPage).toContain('setAttribute("aria-pressed"')
    expect(CLOUD_PLAN_MAP.AGENCY.price.usd.monthly).toBe(499)
    expect(CLOUD_PLAN_MAP.AGENCY.price.inr.monthly).toBe(49_900)
  })
})
