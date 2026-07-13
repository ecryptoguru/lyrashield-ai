import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

describe("waitlist fallback rate limit", () => {
  it("checks and inserts within one D1 statement", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("../pages/api/waitlist.ts", import.meta.url), "utf8")
    expect(source).toMatch(/INSERT INTO waitlist_rate_limit[\s\S]+SELECT \?, \?[\s\S]+COUNT\(\*\)/)
  })

  it("omits an empty referral code from waitlist submissions", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      new URL("../components/WaitlistForm.astro", import.meta.url),
      "utf8"
    )
    expect(source).toContain("referralCode: referralCode || undefined")
  })
})
