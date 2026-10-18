import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLANS, formatUSD } from "@lyrashield/pricing"

const page = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")

describe("homepage journey and plan summary", () => {
  it("keeps the landing path in decision order and links deeper capability pages", () => {
    // The nine-block order from spec section 8: hero, what is different, Lite
    // Check, journey, surfaces, coverage and fit, pricing, FAQ, closing CTA.
    const stages = [
      page.indexOf("<PremiumHero cinematic />"),
      page.indexOf('id="different"'),
      page.indexOf("<HomeLiteScan />"),
      page.indexOf("<EvidenceWorld"),
      page.indexOf("<HeroProductFrame />"),
      page.indexOf('id="surfaces-heading"'),
      page.indexOf('id="coverage-heading"'),
      page.indexOf('id="cloud-plans"'),
      page.indexOf("<Faq items={faqItems} />"),
      page.indexOf("<FinalCta />"),
    ]
    expect(stages.every((position) => position >= 0)).toBe(true)
    expect(stages).toEqual([...stages].sort((left, right) => left - right))
    expect(page).toContain('href="/evidence-vault"')
    // Block 2's evidence-states card names the three shipped states only. The
    // fourth exists in the schema but no shipped path produces it, so the card
    // must not imply it is live (founder ruling, 2026-10-04).
    const different = page.slice(page.indexOf('id="different"'), page.indexOf("<HomeLiteScan />"))
    expect(different).toContain("Three evidence states, never blended")
    expect(different).not.toMatch(/independently verified|verification receipt/i)
    // The retest card must not promise that every finding gets a confirming
    // retest: an engine-only finding ends inconclusive.
    expect(different).toContain("ends inconclusive")

    // Block 8: the FAQ opens its first five questions and keeps all eight in
    // the FAQPage data, so collapsing one hides nothing from an answer engine.
    const faq = readFileSync(new URL("../components/landing/Faq.astro", import.meta.url), "utf8")
    expect(faq).toContain("open={index < OPEN_BY_DEFAULT}")
    expect(faq).toContain("const OPEN_BY_DEFAULT = 5")
    expect(page).toContain("mainEntity: faqItems.map")
    expect(page.match(/^  \{$/gm)?.length ?? 0).toBeGreaterThanOrEqual(8)
    // Block 9 is the single closer: the separate demo block is gone and its
    // link now lives inside the closing CTA.
    expect(page).not.toContain('id="demo-heading"')
    expect(page).toContain("<FinalCta />")
    const closer = readFileSync(
      new URL("../components/landing/FinalCta.astro", import.meta.url),
      "utf8"
    )
    expect(closer).toContain("Get a verdict on your first app.")
    expect(closer).toContain('href="/demo"')
    expect(closer).not.toContain("Read methodology")

    // Block 5 and 6 ids.
    expect(page).toContain('id="surfaces-heading"')
    expect(page).toContain('id="coverage-heading"')
    // The tab strip is keyboard reachable and the panels are wired to it.
    expect(page).toContain('role="tablist"')
    expect(page).toContain("aria-selected")
    expect(page).toContain("ArrowRight")
    for (const surface of ["web", "cli", "action", "agents"]) {
      expect(page).toContain(`surface-tab-${surface}`)
      expect(page).toContain(`surface-panel-${surface}`)
    }
    // The CLI line and every count come from a registry, not from typed digits.
    expect(page).toContain("cliLoginCommand")
    expect(page).toContain("webmcpControlCount")
    expect(page).toContain("reviewControlCount")
    expect(page).toContain("evidenceControlCount")
    // The journey block owns the anchor the header and footer link to.
    expect(page).toContain('id="how-it-works"')
    expect(page.indexOf('id="how-it-works"')).toBeGreaterThan(page.indexOf("<HomeLiteScan />"))
    // The static three-step block is gone: the journey retells that story.
    expect(page).not.toContain("One review, from authorized scope to useful evidence")
    expect(page).not.toContain("Choose scope")
    // The MCP guard evaluation page is no longer cited from the home page as
    // proof: D7 removed the figures and the reproducible runner does not exist,
    // so there is nothing to point at as evidence yet.
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
    expect(page).toContain("Missing evidence stays visible")
    expect(page).toContain("instead of rounding up to a pass")
    expect(page).not.toMatch(/\b\d+[k+] users\b|certified|guaranteed secure/i)
  })
})
