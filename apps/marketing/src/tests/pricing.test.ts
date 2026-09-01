import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const pricingPage = readFileSync(new URL("../pages/pricing.astro", import.meta.url), "utf8")

describe("pricing page", () => {
  it("renders self-serve plans and the contact-led Enterprise tier from the shared catalog", () => {
    expect(pricingPage).toContain("CLOUD_PLANS.filter((plan) => plan.selfServe)")
    expect(pricingPage).toContain('getPlan("ENTERPRISE")')
    expect(pricingPage).not.toContain("const cloudPlans = [")
    expect(pricingPage).toContain("plan.price.usd.monthly")
    expect(pricingPage).toContain("enterprisePlan.price.inr.monthly")
    expect(pricingPage).toContain('setAttribute("aria-pressed"')
  })

  it("matches the canonical repriced catalog (WP1, founder-confirmed 2026-08-29)", () => {
    // SCAN line
    expect(CLOUD_PLAN_MAP.STARTER.price.usd).toEqual({ monthly: 29, annual: 295 })
    expect(CLOUD_PLAN_MAP.STARTER.agentMinutes).toBe(300)
    expect(CLOUD_PLAN_MAP.STARTER.targetCaps).toBe(5)
    expect(CLOUD_PLAN_MAP.STARTER.deepAllowed).toBe(false)
    expect(CLOUD_PLAN_MAP.PRO.price.usd).toEqual({ monthly: 99, annual: 950 })
    expect(CLOUD_PLAN_MAP.PRO.agentMinutes).toBe(1200)
    expect(CLOUD_PLAN_MAP.PRO.targetCaps).toBe(15)
    expect(CLOUD_PLAN_MAP.PRO.deepAllowed).toBe(true)

    // LAUNCH ASSURANCE line — self-serve premium tier
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.price.usd).toEqual({ monthly: 499, annual: 4188 })
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.price.inr).toEqual({ monthly: 49_900, annual: 418_800 })
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.agentMinutes).toBe(6000)
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.targetCaps).toBe(50)
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.selfServe).toBe(true)
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.deepAllowed).toBe(true)

    // ENTERPRISE — contact-led, $1,500 floor, roadmap-qualified controls
    expect(CLOUD_PLAN_MAP.ENTERPRISE.selfServe).toBe(false)
    expect(CLOUD_PLAN_MAP.ENTERPRISE.price.usd.monthly).toBe(1500)
    expect(CLOUD_PLAN_MAP.ENTERPRISE.features.join(" ")).toContain("on request")

    // Team is removed from the catalog
    expect("TEAM" in CLOUD_PLAN_MAP).toBe(false)
    expect("AGENCY" in CLOUD_PLAN_MAP).toBe(false)
  })
})
