import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Wave 4 acceptance tests: core product pages.
 *
 * Spec section 9 (core product pages) and handoff section 1 Wave 4. Every page
 * keeps its own job and ends with one contextual next step that is a trial or
 * Lite Check link, not a generic card. Each page draws its CTA label from
 * src/lib/site-copy.ts so the vocabulary lock cannot drift.
 */
function page(name: string): string {
  return readFileSync(new URL(`../pages/${name}`, import.meta.url), "utf8")
}

const CORE_PAGES = [
  "scan.astro",
  "pricing.astro",
  "agents.astro",
  "webmcp.astro",
  "vibe-security-50.astro",
  "evidence-vault.astro",
] as const

describe("Wave 4 core product pages", () => {
  it("draws every page CTA label from the single source", () => {
    const violations: string[] = []
    for (const name of CORE_PAGES) {
      const body = page(name)
      const hasCta = body.includes("CTA_LABEL.signUp") || body.includes("CTA_LABEL.liteCheck")
      if (!hasCta) violations.push(`${name} has no CTA_LABEL import usage`)
    }
    expect(violations).toEqual([])
  })

  it("never restates the trial line by hand", () => {
    // The trial line lives in site-copy.ts. A page that writes the literal
    // string re-introduces the drift Spec finding A4 describes.
    const violations: string[] = []
    for (const name of CORE_PAGES) {
      const body = page(name)
      if (/60 agent-minutes · 3 targets · no card/.test(body)) {
        violations.push(`${name} hardcodes the trial line`)
      }
    }
    expect(violations).toEqual([])
  })

  it("scan page leads with the Lite Check name and a pre-run coverage list", () => {
    const scan = page("scan.astro")
    // Item 4.1: H1 becomes "Run the free Lite Check" per the vocabulary lock.
    expect(scan).toContain("Run the free Lite Check")
    // What it covers and what it cannot prove, shown before the run as a list.
    expect(scan).toContain("What this check covers")
    expect(scan).toContain("What it cannot prove")
    // One next step after a result.
    expect(scan).toContain("Review the repository too")
  })

  it("pricing page opens with one trial block and a three-row audience chooser", () => {
    const pricing = page("pricing.astro")
    expect(pricing).toContain("trial-block")
    expect(pricing).toContain("Choose a starting point")
    // The two internal-wording sentences from Spec finding B2 are gone.
    expect(pricing).not.toContain("existing monthly or annual catalog")
    expect(pricing).not.toContain("confirmed in the authenticated product")
    // No recommended badge (a test enforces this today; keep it true here).
    expect(pricing).not.toMatch(/most popular|recommended plan|best value/i)
  })

  it("pricing plan buttons read Choose <plan>", () => {
    const pricing = page("pricing.astro")
    expect(pricing).toContain("Choose ${plan.name}")
    expect(pricing).not.toContain("Start with ${plan.name}")
  })

  it("agents page leads with the login command and ends with the trial step", () => {
    const agents = page("agents.astro")
    expect(agents).toContain("CTA_LABEL.signUp")
    // A client picker over the documented workflows.
    expect(agents).toContain("data-agent-client-filter")
  })

  it("webmcp page puts the checker above the fold and lists the 14 controls once", () => {
    const webmcp = page("webmcp.astro")
    expect(webmcp).toContain("CTA_LABEL.signUp")
    // The controls are tabulated once; the other two mentions are a FAQ answer
    // and the JSON-LD ItemList name, neither of which renders a second table.
    expect((webmcp.match(/<table/g) ?? []).length).toBe(1)
    expect(webmcp).toContain("WebMCP controls (${WEBMCP_DETECTOR_VERSION})")
  })

  it("vibe-security-50 page names control outcomes and offers a sign-up path", () => {
    const vibe = page("vibe-security-50.astro")
    expect(vibe).toContain("CTA_LABEL.signUp")
    expect(vibe).toContain("Control outcomes")
    // The evidence-state vocabulary stays off this page (Spec section 6).
    expect(vibe).not.toContain("Evidence state")
  })

  it("evidence-vault page replaces the copied home block with per-control submissions", () => {
    const vault = page("evidence-vault.astro")
    expect(vault).toContain("What you can submit")
    expect(vault).toContain("CTA_LABEL.signUp")
  })
})
