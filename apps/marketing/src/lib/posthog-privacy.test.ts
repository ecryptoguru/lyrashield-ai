import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  marketingAnalyticsAllowed,
  marketingAnalyticsCookie,
  marketingAnalyticsPreference,
  MARKETING_EVENT_ALLOWLIST,
  optionalTrackingCookieExpirations,
  privacyBoundedMarketingEvent,
  sanitizeMarketingProperties,
  type MarketingEventName,
} from "./posthog-privacy"

describe("marketing analytics preference", () => {
  it("defaults an anonymous visitor to enabled and honors browser/account opt-outs", () => {
    expect(marketingAnalyticsPreference("")).toBeNull()
    expect(marketingAnalyticsAllowed({ cookie: "", accountEnabled: true })).toBe(true)
    expect(
      marketingAnalyticsAllowed({ cookie: "lyrashield-analytics=off", accountEnabled: true })
    ).toBe(false)
    expect(marketingAnalyticsAllowed({ cookie: "", accountEnabled: false })).toBe(false)
    expect(marketingAnalyticsAllowed({ cookie: "", accountEnabled: null })).toBe(false)
    expect(marketingAnalyticsAllowed({ cookie: "", accountEnabled: true, doNotTrack: "YES" })).toBe(
      false
    )
    expect(
      marketingAnalyticsAllowed({ cookie: "", accountEnabled: true, globalPrivacyControl: true })
    ).toBe(false)
  })

  it("shares the 180-day browser choice only across canonical product hosts", () => {
    expect(marketingAnalyticsCookie(false, "lyrashieldai.com", true)).toContain(
      "Domain=.lyrashieldai.com"
    )
    expect(marketingAnalyticsCookie(true, "preview.example.test", false)).not.toContain("Domain=")
    expect(marketingAnalyticsCookie(true, "preview.example.test", false)).toContain(
      "Max-Age=15552000"
    )
  })

  it("expires optional tracking cookies on the local and shared domains", () => {
    const expirations = optionalTrackingCookieExpirations("app.lyrashieldai.com", true)
    expect(expirations).toHaveLength(8)
    expect(expirations).toContain(
      "lyrashield-acq=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; Domain=.lyrashieldai.com; Secure"
    )
    expect(expirations).toContain(
      "ls_ref=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; Domain=.lyrashieldai.com; Secure"
    )
    expect(optionalTrackingCookieExpirations("preview.example.test", false)).toHaveLength(4)
  })
})

describe("privacyBoundedMarketingEvent", () => {
  it("removes session-entry query strings, fragments, and malformed URLs", () => {
    const event = privacyBoundedMarketingEvent({
      properties: {
        $current_url: "https://example.test/page?secret=1#fragment",
        $session_entry_url: "https://example.test/path?secret=1#fragment",
        $session_entry_referrer: "https://example.test/path?secret=1#fragment",
        $initial_referrer: "/relative?secret=1",
        $referrer: "file:///private/secret.txt",
        cta_id: "hero",
      },
    })

    expect(event.properties).toEqual({
      $current_url: "https://example.test/page",
      $session_entry_url: "https://example.test/path",
      $session_entry_referrer: "https://example.test/path",
      cta_id: "hero",
    })
  })

  it("strips target-derived and finding-detail keys from any event at send time", () => {
    const event = privacyBoundedMarketingEvent({
      properties: {
        target_domain_hash: "f".repeat(64),
        categories_flagged: ["secrets"],
        category: "secrets",
        severity: "needs_attention",
        target_url: "https://victim.example",
        url: "https://victim.example",
        cta_id: "hero",
      },
    })

    expect(event.properties).toEqual({ cta_id: "hero" })
  })
})

describe("sanitizeMarketingProperties", () => {
  const targetDerived = {
    target_domain_hash: "f".repeat(64),
    categories_flagged: ["secrets", "headers"],
    category: "secrets",
    severity: "needs_attention",
    target_url: "https://victim.example/path",
    url: "https://victim.example/path",
  }

  it("strips target-derived properties from every declared marketing event", () => {
    for (const event of Object.keys(MARKETING_EVENT_ALLOWLIST)) {
      const sanitized = sanitizeMarketingProperties(event as MarketingEventName, {
        ...targetDerived,
      })
      expect(sanitized, `${event} must not carry target-derived properties`).toBeNull()
    }
  })

  it("never allowlists a target-derived or finding-detail key", () => {
    const forbidden = [
      "target_domain_hash",
      "categories_flagged",
      "category",
      "severity",
      "target_url",
      "url",
    ]
    for (const [event, allowed] of Object.entries(MARKETING_EVENT_ALLOWLIST)) {
      for (const key of forbidden) {
        expect(allowed, `${event} must not allow ${key}`).not.toContain(key)
      }
    }
  })

  it("keeps only the allowlisted Lite Check funnel counters", () => {
    expect(
      sanitizeMarketingProperties("scan_completed", {
        duration_ms: 1180,
        finding_count: 3,
        had_findings: true,
        categories_flagged: ["secrets"],
        target_domain_hash: "f".repeat(64),
      })
    ).toEqual({ duration_ms: 1180, finding_count: 3, had_findings: true })

    expect(
      sanitizeMarketingProperties("scan_started", {
        product: "LyraShield",
        device: "mobile",
        utm_source: "newsletter",
        target_domain_hash: "f".repeat(64),
        url: "https://victim.example",
      })
    ).toEqual({ product: "LyraShield", device: "mobile", utm_source: "newsletter" })

    expect(
      sanitizeMarketingProperties("scan_error", {
        product: "LyraShield",
        reason: "unreachable",
        target_domain_hash: "f".repeat(64),
      })
    ).toEqual({ product: "LyraShield", reason: "unreachable" })
  })

  it("sends finding_expanded without finding detail", () => {
    expect(
      sanitizeMarketingProperties("finding_expanded", {
        product: "LyraShield",
        category: "secrets",
        severity: "needs_attention",
      })
    ).toEqual({ product: "LyraShield" })
  })

  it("drops properties that no allowlist entry names", () => {
    expect(sanitizeMarketingProperties("cta_click", { cta_id: "hero", extra_field: "x" })).toEqual({
      cta_id: "hero",
    })
    expect(sanitizeMarketingProperties("waitlist_form_start", { role: "founder" })).toBeNull()
  })
})

describe("Lite Check analytics source", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

  it("keeps scan.astro free of target-derived hashing", () => {
    const page = source("../pages/scan.astro")
    expect(page).not.toContain("hashDomain")
    expect(page).not.toContain("crypto.subtle.digest")
    expect(page).not.toContain("target_domain_hash:")
    expect(page).not.toContain("categories_flagged:")
    expect(page).toContain("sanitizeMarketingProperties")
  })

  it("routes every marketing capture through the property sanitizer", () => {
    for (const path of [
      "../pages/scan.astro",
      "../layouts/Base.astro",
      "../components/WaitlistForm.astro",
    ]) {
      expect(source(path), `${path} must sanitize captured properties`).toContain(
        "sanitizeMarketingProperties"
      )
    }
  })

  it("keeps the illustrative journey free of analytics", () => {
    const journey = source("../components/landing/evidence-journey.ts")
    expect(journey).not.toContain("posthog")
    expect(journey).not.toContain(".capture(")
  })

  it("does not import or capture PostHog until the account and browser preferences allow it", () => {
    const base = source("../layouts/Base.astro")
    expect(base).toContain("marketingAnalyticsAllowed")
    expect(base).toContain("accountEnabled: accountAnalyticsEnabled")
    expect(base).toContain("if (!posthogKey || !trackingAllowed() || initializingPosthog) return")
    expect(base).toContain('credentials: "include"')
    expect(base).toContain("ph.opt_out_capturing()")
    expect(base).toContain("data-analytics-toggle")
    expect(base).toContain("/api/privacy/analytics-opt-out")
  })
})
