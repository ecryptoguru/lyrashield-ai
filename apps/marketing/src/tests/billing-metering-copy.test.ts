import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ")
const terms = read("../pages/terms-of-sale.astro")
const metering = terms.match(/<h2[^>]*>Metering<\/h2><p>(.*?)<\/p>/)?.[1] ?? ""
const archiveUrl = new URL("../../public/legal/terms-of-sale-2026-08-24.txt", import.meta.url)
const billing = read("../../../web/src/app/(dashboard)/dashboard/billing/page.tsx")
const architecture = read("../../../../codebase.md")

describe("whole-minute billing disclosure", () => {
  it("visibly acknowledges the prior disclosure and makes the correction effective on publication", () => {
    expect(terms).toContain("Billing disclosure correction")
    expect(terms).toContain("Earlier Terms of Sale described agent-minutes as")
    expect(terms).toContain("metered per second")
    expect(terms).toContain(
      "This corrected disclosure takes effect when these updated terms are published."
    )
    expect(terms).toContain("It does not mean you accepted this wording earlier")
    expect(terms).toContain("does not change earlier charges")
    expect(terms).toContain(
      "Earlier charges that may be affected by the previous wording will be reviewed separately."
    )
    expect(terms).toContain('href="/legal/terms-of-sale-2026-08-24.txt"')
  })

  it("keeps the previous terms publicly retrievable with their original metering and cancellation text", () => {
    expect(existsSync(archiveUrl)).toBe(true)
    const archive = readFileSync(archiveUrl, "utf8")
    expect(archive).toContain("Last reviewed: 24 Aug 2026")
    expect(archive).toContain("An agent-minute is wall-clock scan time, metered per second.")
    expect(archive).toContain("You can cancel a Cloud subscription at any time in the dashboard.")
    expect(archive).toContain("The included monthly pool does not roll over.")
    expect(archive).toContain("prepaid minute packs are non-refundable")
  })

  it("dates the revised draft accurately and explains provider-specific cancellation paths", () => {
    expect(terms).toContain('const reviewed = "2026-10-13"')
    expect(terms).toContain("Last reviewed: <time datetime={reviewed}>13 Oct 2026</time>")
    expect(terms).toContain("Polar customers open the customer portal")
    expect(terms).toContain(
      "Razorpay customers contact billing support for cancellation assistance"
    )
    expect(terms).toContain("Cloud subscriptions can be canceled at any time.")
    expect(terms).not.toContain("You can cancel a Cloud subscription at any time in the dashboard")
  })

  it("discloses rounding before the multiplier in terms and account usage", () => {
    for (const source of [metering, billing]) {
      expect(source).toContain("Any partial minute is rounded up to the next whole minute.")
      expect(source).toMatch(
        /(?:Deep and Custom|Deep\/Custom) scans consume (?:minutes at three times the standard rate|3× minutes) after rounding\./
      )
      expect(source).not.toContain("metered per second")
    }
    expect(terms).toContain("Standard scan that runs for 20 seconds consumes 1 agent-minute")
    expect(terms).toContain("Deep scan that runs for 20 seconds consumes 3 agent-minutes")
  })

  it("keeps failed scans unbilled and states the cancellation rounding rule", () => {
    expect(terms).toContain("Failed scans are not billed.")
    expect(billing).toContain("Failed scans are not billed.")
    for (const source of [terms, billing]) expect(source).toContain("same whole-minute rounding")
    expect(architecture).not.toContain("failed runs with positive provider usage remain billable")
    expect(architecture).toContain(
      "Failed scans are not billed, even when provider usage was observed."
    )
  })
})
