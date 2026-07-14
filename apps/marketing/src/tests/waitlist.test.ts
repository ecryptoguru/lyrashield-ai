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

describe("public marketing claims", () => {
  it("does not promise unavailable or universal security outcomes", () => {
    const publicFiles = [
      "../pages/index.astro",
      "../pages/methodology.astro",
      "../pages/llms.txt.ts",
      "../components/landing/Hero.astro",
      "../components/landing/Loop.astro",
      "../components/landing/Faq.astro",
      "../components/landing/TwoDepths.astro",
    ]
    const source = publicFiles
      .map((path) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return readFileSync(new URL(path, import.meta.url), "utf8")
      })
      .join("\n")

    expect(source).not.toMatch(
      /verifies every finding|opens the fix PR|one-click fix PR|provably gone|scans like an attacker/i
    )
    expect(source).toContain("retest-confirmed fixes")
    expect(source).toContain("PR execution stays blocked")
  })
})
