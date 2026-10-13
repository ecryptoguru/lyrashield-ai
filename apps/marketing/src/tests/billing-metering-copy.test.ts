import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ")
const terms = read("../pages/terms-of-sale.astro")
const billing = read("../../../web/src/app/(dashboard)/dashboard/billing/page.tsx")
const architecture = read("../../../../codebase.md")

describe("whole-minute billing disclosure", () => {
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
    for (const source of [terms, billing]) {
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
