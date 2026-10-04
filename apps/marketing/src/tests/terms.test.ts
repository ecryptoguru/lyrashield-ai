import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const terms = readFileSync(new URL("../pages/terms.astro", import.meta.url), "utf8")

describe("Terms of Service page", () => {
  it("no longer describes itself as a draft", () => {
    // The sign-up screen links here and says the visitor agrees to the Terms of
    // Service, so the page may not call itself a product-use summary for
    // founder review or a substitute for finalized terms.
    expect(terms).not.toContain("for founder review")
    expect(terms).not.toContain("not a substitute")
    expect(terms).not.toContain("product-use summary")
  })

  it("leaves no fill-in placeholder in the built page", () => {
    // Every placeholder from the draft must be resolved, or the page would ship
    // with a bracket visible to a visitor who is agreeing to it.
    for (const placeholder of [
      "[LEGAL ENTITY NAME]",
      "[REGISTERED ADDRESS]",
      "[GOVERNING LAW]",
      "[CITY AND COUNTRY]",
      "[EFFECTIVE DATE]",
      "[DATE IN THE FORM",
    ]) {
      expect(terms, `${placeholder} must be resolved`).not.toContain(placeholder)
    }
    expect(terms).not.toMatch(/\[[A-Z][A-Z ]+\]/)
  })

  it("carries the founder's entity, address and governing law", () => {
    expect(terms).toContain("LyraShield AI of A 10, Metro Tower, Acharya Vihar")
    expect(terms).toContain("Bhubaneswar, Odisha 751022, India")
    expect(terms).toContain("governed by the laws of India")
    expect(terms).toContain("Courts at Bhubaneswar, Odisha, India have exclusive jurisdiction")
  })

  it("links the Terms of Sale and the Privacy page from the intro", () => {
    const intro = terms.slice(
      terms.indexOf("These terms are an agreement"),
      terms.indexOf('<div class="prose')
    )
    expect(intro).toContain('href="/terms-of-sale"')
    expect(intro).toContain('href="/privacy"')
  })

  it("keeps the page title and the route", () => {
    expect(terms).toContain('title="Terms of Service | LyraShield AI"')
    expect(terms).toContain('new URL("/terms", origin)')
    expect(terms).toContain('name: "LyraShield AI Terms of Service"')
  })

  it("keeps the consented-to authorization and Lite Check wording as clauses 3 and 4", () => {
    // The Lite Check consent checkbox links here, so the wording the visitor
    // agreed to must survive the rewrite.
    expect(terms).toContain('heading: "3. Authorization to test"')
    expect(terms).toContain(
      "You may submit only targets you own or have explicit permission to test"
    )
    expect(terms).toContain('heading: "4. What the free tools do"')
    expect(terms).toContain(
      "bounded GET requests for a public page and a small number of same-origin assets"
    )
    expect(terms).toContain(
      "does not log in or exploit or fuzz or brute-force or enumerate a database"
    )
  })

  it("states the fix rule in the approved wording", () => {
    expect(terms).toContain(
      "A fix pull request opens only after a human approves it and it carries a server-generated patch."
    )
    expect(terms).not.toMatch(/automatic fix|fixes? (?:are|is) automatic/i)
  })

  it("keeps the last-reviewed element and an honest reviewed date", () => {
    expect(terms).toContain("Last reviewed:")
    expect(terms).toContain("<time")
    expect(terms).toContain("datetime={lastReviewedIso}")
    // Open beta is stated in clause 2, per the draft.
    expect(terms).toContain("LyraShield is in open beta.")
  })

  it("covers all nineteen clauses", () => {
    const headings = [...terms.matchAll(/heading: "(\d+)\./g)].map((match) => Number(match[1]))
    expect(headings).toEqual(Array.from({ length: 19 }, (_, index) => index + 1))
  })
})
