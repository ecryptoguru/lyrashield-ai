import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

describe("waitlist fallback rate limit", () => {
  it("checks and inserts within one D1 statement", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("../lib/waitlist-rate-limit.ts", import.meta.url), "utf8")
    expect(source).toMatch(/INSERT INTO waitlist_rate_limit[\s\S]+SELECT \?, \?[\s\S]+COUNT\(\*\)/)
  })

  it("trusts only Cloudflare's Worker-boundary client IP header", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("../lib/waitlist-rate-limit.ts", import.meta.url), "utf8")
    expect(source).toContain('request.headers.get("cf-connecting-ip")')
    expect(source).not.toContain('request.headers.get("x-forwarded-for")')
  })

  it("rate limits waitlist position lookups", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      new URL("../pages/api/waitlist/position.ts", import.meta.url),
      "utf8"
    )
    expect(source).toContain("checkD1RateLimit")
    expect(source).toContain("WAITLIST_RL")
    expect(source).toContain("status: 429")
  })

  it("does not publish RSS from non-indexable preview deployments", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL("../pages/rss.xml.ts", import.meta.url), "utf8")
    expect(source).toContain("if (!__MARKETING_INDEXABLE__)")
    expect(source).toContain("status: 404")
  })

  it("omits an empty referral code from waitlist submissions", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      new URL("../components/WaitlistForm.astro", import.meta.url),
      "utf8"
    )
    expect(source).toContain("referralCode: referralCode || undefined")
  })

  it("preserves allowlisted tool attribution", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      new URL("../components/WaitlistForm.astro", import.meta.url),
      "utf8"
    )
    expect(source).toContain('requestedSource === "tools" || requestedSource === "tool"')
    expect(source).toContain(
      '(form.querySelector("[name=source]") as HTMLInputElement).value = source'
    )
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
