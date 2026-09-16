import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLAN_MAP, PACK_VALIDITY_DAYS } from "@lyrashield/pricing"

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

  it("matches the canonical repriced catalog (WP1, founder-confirmed 2026-08-29; allowances repacked 2026-09-13)", () => {
    // TRIAL — reduced 2026-09-13: 7 days, 60 one-time minutes
    expect(CLOUD_PLAN_MAP.TRIAL.agentMinutes).toBe(60)
    expect(CLOUD_PLAN_MAP.TRIAL.targetCaps).toBe(3)
    expect(CLOUD_PLAN_MAP.TRIAL.deepAllowed).toBe(false)
    expect(CLOUD_PLAN_MAP.TRIAL.price.usd).toEqual({ monthly: 0, annual: 0 })

    // SCAN line
    expect(CLOUD_PLAN_MAP.STARTER.price.usd).toEqual({ monthly: 29, annual: 295 })
    expect(CLOUD_PLAN_MAP.STARTER.agentMinutes).toBe(210)
    expect(CLOUD_PLAN_MAP.STARTER.targetCaps).toBe(5)
    expect(CLOUD_PLAN_MAP.STARTER.deepAllowed).toBe(false)
    expect(CLOUD_PLAN_MAP.PRO.price.usd).toEqual({ monthly: 99, annual: 950 })
    expect(CLOUD_PLAN_MAP.PRO.agentMinutes).toBe(850)
    expect(CLOUD_PLAN_MAP.PRO.targetCaps).toBe(15)
    expect(CLOUD_PLAN_MAP.PRO.deepAllowed).toBe(true)

    // LAUNCH ASSURANCE line — self-serve premium tier
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.price.usd).toEqual({ monthly: 499, annual: 4188 })
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.price.inr).toEqual({ monthly: 49_900, annual: 418_800 })
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.agentMinutes).toBe(4500)
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

  it("states agent-native surfaces on each self-serve paid card", () => {
    // Trial availability is covered by the shared-capabilities note below.
    const SURFACES_LINE = "CLI, GitHub Action and MCP server access"
    expect(CLOUD_PLAN_MAP.STARTER.features).toContain(SURFACES_LINE)
    expect(CLOUD_PLAN_MAP.PRO.features).toContain(SURFACES_LINE)
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.features).toContain(SURFACES_LINE)
    expect(CLOUD_PLAN_MAP.TRIAL.features).not.toContain(SURFACES_LINE)
  })

  it("differentiates Agency by its enforced limits and overage", () => {
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.features).toContain(
      "Overage at $0.15/min with a user-set spend limit"
    )
    expect(CLOUD_PLAN_MAP.PRO.features.join(" ")).not.toContain("Overage")
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.features.join(" ")).not.toContain("merges blocked")
    expect(CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.features.join(" ")).not.toContain("WebMCP Assurance")
  })

  it("uses workspace-scoped evidence wording on Starter", () => {
    expect(CLOUD_PLAN_MAP.STARTER.features).toContain("Workspace evidence records")
    expect(CLOUD_PLAN_MAP.STARTER.features).not.toContain("Evidence Vault access")
  })

  it("shows Local as a blurred, non-purchasable future launch", () => {
    expect(pricingPage).toContain("Local is launching later")
    expect(pricingPage).toContain('aria-hidden="true" inert')
    expect(pricingPage).toContain("blur-sm")
    expect(pricingPage).not.toContain("/api/billing/local-availability")
    expect(pricingPage).not.toContain("/buy/local")
    expect(pricingPage).toContain("formatUSD(localLaunch.priceUsd)")
    expect(pricingPage).toContain("formatINR(localLaunch.priceInr!)")
  })

  it("states shared capabilities and the required CI setup without a plan-exclusive gate claim", () => {
    expect(pricingPage).toContain("Included across plans")
    expect(pricingPage).toContain("The free GitHub Action runs scan-level SARIF")
    expect(pricingPage).toContain("without a LyraShield account or API key")
    expect(pricingPage).toContain("Eligible workspace members on every plan")
    expect(pricingPage).toContain(
      "versioned launch verdicts, launch reports and shareable scorecards"
    )
    expect(pricingPage).toContain("require its check in your repository settings")
    expect(pricingPage).not.toContain("Launch Assurance tier's gate")
  })

  it("renders pack validity from the catalog constant, never a hardcoded month count", () => {
    expect(PACK_VALIDITY_DAYS).toBe(180)
    expect(`${PACK_VALIDITY_DAYS} days`).toBe("180 days")
    expect(pricingPage).toContain("PACK_VALIDITY_DAYS")
    expect(pricingPage).not.toContain("6 months")
  })
})
