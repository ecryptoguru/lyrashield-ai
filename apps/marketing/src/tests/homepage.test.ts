import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLANS, formatUSD } from "@lyrashield/pricing"

const page = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")

describe("homepage journey and plan summary", () => {
  it("keeps the landing path in decision order and links deeper capability pages", () => {
    const stages = [
      page.indexOf("<PremiumHero cinematic />"),
      page.indexOf("<EvidenceWorld"),
      page.indexOf("<HeroProductFrame />"),
      page.indexOf("<HomeLiteScan />"),
      page.indexOf('id="cloud-plans"'),
      page.indexOf("<Faq items={faqItems} />"),
      page.indexOf("<FinalCta />"),
    ]
    expect(stages.every((position) => position >= 0)).toBe(true)
    expect(stages).toEqual([...stages].sort((left, right) => left - right))
    for (const href of [
      "/methodology",
      "/vibe-security-50",
      "/evidence-vault",
      "/agents",
      "/webmcp",
    ])
      expect(page).toContain(`href="${href}"`)
    expect(page).toContain('id="how-it-works"')
    expect(page).toContain("mainEntity: faqItems.map")
    const faq = readFileSync(new URL("../components/landing/Faq.astro", import.meta.url), "utf8")
    expect(faq).toContain('id="faq"')
    expect(faq).not.toContain("open={")
    expect(page).not.toContain('role="tablist"')
    expect(page).not.toContain('href="/ai-safety"')
  })

  it("renders plan prices and limits from the shared catalog without a recommended tier", () => {
    // Retired internal wording (spec finding B2): purchase availability is
    // public on both rails, so neither sentence may come back.
    expect(page).not.toContain("existing monthly or annual catalog")
    expect(page).not.toContain("authenticated product")
    // Each card carries a Choose button labelled from the plan name.
    expect(page).toContain("Choose {plan.name}")
    expect(page).toContain("planIntent[plan.id]")
    // The agent-minute definition appears once, as a tooltip.
    expect(page).toContain("Wall-clock server time")
    expect(page.match(/Wall-clock server time/g)).toHaveLength(1)
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
    // The old assertion read the retired three-step block. The same point is
    // still made on the page by the journey block and the coverage section.
    expect(page).toContain("Missing coverage stays visible")
    expect(page).toContain("engine-only absence stays inconclusive")
    expect(page).not.toMatch(/\b\d+[k+] users\b|certified|guaranteed secure/i)
  })
})
