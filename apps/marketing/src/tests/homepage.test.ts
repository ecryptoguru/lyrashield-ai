import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLANS, formatUSD } from "@lyrashield/pricing"

const evidenceMap = readFileSync(
  new URL("../components/landing/EvidenceMap.astro", import.meta.url),
  "utf8"
)
const journey = readFileSync(new URL("../lib/motion-manifest.ts", import.meta.url), "utf8")
const page = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")

describe("homepage journey and plan summary", () => {
  it("keeps the landing path in decision order and links deeper capability pages", () => {
    // The visual-first journey preserves the cinematic story and deeper links.
    const stages = [
      page.indexOf("<PremiumHero cinematic />"),
      page.indexOf("<EvidenceMap />"),
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
    expect(evidenceMap).toContain('id="different"')
    for (const state of ["Detected", "Retest-confirmed", "Inconclusive"]) {
      expect(evidenceMap).toContain(state)
    }
    expect(evidenceMap).not.toMatch(/independently verified|verification receipt/i)
    expect(journey).toContain("missing proof stays inconclusive")

    // Retain native FAQ disclosures and all four crawlable schema answers.
    const faq = readFileSync(new URL("../components/landing/Faq.astro", import.meta.url), "utf8")
    expect(faq).toContain('aria-labelledby="faq-heading"')
    expect(faq).toContain("<details")
    expect(page).toContain("mainEntity: faqItems.map")
    const questions = [...page.matchAll(/^    q: /gm)]
    expect(questions).toHaveLength(4)
    // The closer has one action; the demo remains in the evidence map.
    expect(page).not.toContain('id="demo-heading"')
    expect(page).toContain("<FinalCta />")
    const closer = readFileSync(
      new URL("../components/landing/FinalCta.astro", import.meta.url),
      "utf8"
    )
    expect(closer).toContain("Review your next release.")
    expect(evidenceMap).toContain('href="/demo"')
    expect(closer).not.toContain("Read methodology")

    // Block 5 and 6 ids.
    expect(page).toContain('id="surfaces-heading"')
    expect(page).toContain('id="coverage-heading"')
    // Integration links and a native CLI disclosure replace the verbose tabs.
    expect(page).toContain("<details")
    expect(page).toContain("cliLoginCommand")
    expect(page).toContain("data-copy-cli")
    expect(page).toContain('href="/docs/integrations/github-action"')
    expect(page).toContain('href="/agents"')
    expect(page).not.toContain('role="tablist"')
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
    expect(page).not.toContain("planIntent[plan.id]")
    // The agent-minute definition appears once, as a visible footnote.
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
    expect(journey).toContain("missing proof stays inconclusive")
    expect(journey).toContain("Coverage shows which checks ran and where assessment was limited.")
    expect(page).not.toMatch(/\b\d+[k+] users\b|certified|guaranteed secure/i)
  })
})
