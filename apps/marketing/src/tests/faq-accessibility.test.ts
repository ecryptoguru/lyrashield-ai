import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const pricingPage = readFileSync(new URL("../pages/pricing.astro", import.meta.url), "utf8")
const landingFaq = readFileSync(new URL("../components/landing/Faq.astro", import.meta.url), "utf8")

describe("marketing FAQ touch targets", () => {
  it("keeps the pricing FAQ summary at least 44px tall", () => {
    expect(pricingPage).toMatch(/<summary class="[^"]*min-h-11[^"]*">/)
  })

  it("keeps the landing FAQ summary at least 44px tall", () => {
    expect(landingFaq).toMatch(/<summary class="[^"]*min-h-11[^"]*">/)
  })
})
