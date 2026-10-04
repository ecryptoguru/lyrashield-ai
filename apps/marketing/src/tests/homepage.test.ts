import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLANS, formatUSD } from "@lyrashield/pricing"

const page = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")

describe("homepage journey and plan summary", () => {
  it("keeps the landing path in decision order and links deeper capability pages", () => {
    const stages = [
      page.indexOf("<PremiumHero />"),
      page.indexOf('id="how-it-works"'),
      page.indexOf("<HeroProductFrame />"),
      page.indexOf("<HomeLiteScan />"),
      page.indexOf('id="capabilities-heading"'),
      page.indexOf('id="cloud-plans"'),
      page.indexOf("<Faq items={faqItems} />"),
      page.indexOf('id="demo-heading"'),
      page.indexOf("<FinalCta />"),
    ]
    expect(stages.every((position) => position >= 0)).toBe(true)
    expect(stages).toEqual([...stages].sort((left, right) => left - right))
    expect(page).toContain('href="/evidence-vault"')
    // The MCP guard evaluation page is no longer cited from the home page as
    // proof: D7 removed the figures and the reproducible runner does not exist,
    // so there is nothing to point at as evidence yet.
    expect(page).not.toContain('href="/ai-safety"')
  })

  it("renders plan prices and limits from the shared catalog without a recommended tier", () => {
    expect(page).toContain("CLOUD_PLANS.filter((plan) => plan.selfServe)")
    expect(page).toContain("formatUSD(plan.price.usd.monthly)")
    expect(page).toContain("formatUSD(plan.price.usd.annual)")
    expect(page).toContain("plan.agentMinutes.toLocaleString()")
    expect(page).toContain("plan.targetCaps")
    // The trial line now comes from the single source (src/lib/site-copy.ts)
    // instead of an inline expression, so the pricing page and the homepage
    // can no longer state the trial differently.
    expect(page).toContain("TRIAL_LINE")
    expect(page).toContain('from "../lib/site-copy"')
    expect(page).toContain("enterprisePlan.price.usd.monthly")
    expect(page).toContain('href="/pricing"')
    expect(page).not.toMatch(/most popular|recommended plan|best value/i)

    for (const plan of CLOUD_PLANS.filter((candidate) => candidate.selfServe)) {
      expect(formatUSD(plan.price.usd.monthly)).toMatch(/^\$[\d,]+\.\d{2}$/)
      expect(formatUSD(plan.price.usd.annual)).toMatch(/^\$[\d,]+\.\d{2}$/)
      expect(plan.agentMinutes).toBeGreaterThan(0)
      expect(plan.targetCaps).toBeGreaterThan(0)
    }
  })

  it("keeps the preview bounded and makes no customer-count or certification claim", () => {
    expect(page).toContain("<HeroProductFrame />")
    expect(page).toContain("what was checked, what needs attention")
    expect(page).not.toMatch(/\b\d+[k+] users\b|certified|guaranteed secure/i)
  })
})
