import { describe, expect, it, vi } from "vitest"
import {
  sanitizeProperties,
  EVENT_ALLOWLIST,
  acquisitionCookieValue,
  analyticsOptedOut,
  rememberAcquisition,
  readSignupAttribution,
  signupErrorUrl,
  track,
  flushQueuedAnalytics,
} from "./analytics"

describe("sanitizeProperties", () => {
  it("returns only allowed properties for an event", () => {
    const result = sanitizeProperties("landing_view", {
      utm_source: "x",
      utm_campaign: "launch",
      extra: "should be dropped",
    })
    expect(result).toEqual({ utm_source: "x", utm_campaign: "launch" })
  })

  it("drops forbidden properties even when allowed by event", () => {
    const result = sanitizeProperties("repos_loaded", {
      repo_count_bucket: "small",
      repo_name: "secret-repo",
      file_path: "/etc/passwd",
      cost: 1.5,
    })
    expect(result).toEqual({ repo_count_bucket: "small" })
    expect(result).not.toHaveProperty("repo_name")
    expect(result).not.toHaveProperty("file_path")
    expect(result).not.toHaveProperty("cost")
  })

  it("drops overlong strings", () => {
    const longValue = "a".repeat(1000)
    const result = sanitizeProperties("signup_started", { method: longValue })
    expect(result).toBeNull()
  })

  it("returns null when no properties remain", () => {
    const result = sanitizeProperties("github_connect_started", { unknown: "value" })
    expect(result).toBeNull()
  })

  it("keeps bounded signup attribution without accepting a target URL", () => {
    expect(
      sanitizeProperties("signup_started", {
        method: "github",
        source: "landing_hero",
        cta: "create_account",
        target_url: "https://private.example",
      })
    ).toEqual({ method: "github", source: "landing_hero", cta: "create_account" })
  })

  it("has an exhaustive event allowlist", () => {
    const events = Object.keys(EVENT_ALLOWLIST)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(Array.isArray(EVENT_ALLOWLIST[event as keyof typeof EVENT_ALLOWLIST])).toBe(true)
    }
  })
})

describe("track", () => {
  it("does not throw when posthog is not loaded", () => {
    expect(() => track("landing_view", { utm_source: "x" })).not.toThrow()
  })

  it("flushes an allowlisted first event after the SDK loads", () => {
    const previousKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test"
    vi.stubGlobal("window", {})
    vi.stubGlobal("navigator", { doNotTrack: null, globalPrivacyControl: false })
    try {
      track("signup_page_viewed", { source: "landing_hero", target_url: "https://private.example" })
      const capture = vi.fn()
      flushQueuedAnalytics(capture)
      expect(capture).toHaveBeenCalledWith("signup_page_viewed", { source: "landing_hero" })
    } finally {
      flushQueuedAnalytics()
      vi.unstubAllGlobals()
      if (previousKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY
      else process.env.NEXT_PUBLIC_POSTHOG_KEY = previousKey
    }
  })

  it("discards pending events if privacy opt-out appears before SDK load", () => {
    const previousKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test"
    vi.stubGlobal("window", {})
    vi.stubGlobal("navigator", { doNotTrack: null, globalPrivacyControl: false })
    try {
      track("results_viewed", { status: "COMPLETED" })
      vi.stubGlobal("navigator", { doNotTrack: "1", globalPrivacyControl: false })
      track("results_viewed", { status: "COMPLETED" })
      const capture = vi.fn()
      flushQueuedAnalytics(capture)
      expect(capture).not.toHaveBeenCalled()
    } finally {
      flushQueuedAnalytics()
      vi.unstubAllGlobals()
      if (previousKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY
      else process.env.NEXT_PUBLIC_POSTHOG_KEY = previousKey
    }
  })
})

describe("signup attribution", () => {
  it("honors DNT/GPC and preserves the first valid acquisition cookie", () => {
    expect(analyticsOptedOut("1", false)).toBe(true)
    expect(analyticsOptedOut(null, true)).toBe(true)
    expect(analyticsOptedOut(null, false)).toBe(false)
    let cookie = ""
    const documentStub = {
      get cookie() {
        return cookie
      },
      set cookie(value: string) {
        cookie = value
      },
    }
    vi.stubGlobal("document", documentStub)
    vi.stubGlobal("navigator", { doNotTrack: "1", globalPrivacyControl: false })
    vi.stubGlobal("window", { location: { protocol: "https:" } })
    try {
      rememberAcquisition({ source: "first" })
      expect(cookie).toBe("")
      vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: false })
      rememberAcquisition({ source: "first" })
      rememberAcquisition({ source: "second" })
      expect(cookie).toContain("first")
      expect(cookie).not.toContain("second")
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("retains valid plan intent across OAuth retry without allowing redirect injection", () => {
    expect(signupErrorUrl({ source: "pricing" }, "LAUNCH_ASSURANCE")).toBe(
      "/sign-up?source=pricing&plan=LAUNCH_ASSURANCE"
    )
    expect(signupErrorUrl({}, "PRO&callbackURL=//evil.example")).toBe("/sign-up")
  })
  it("keeps only bounded campaign tokens across an OAuth error return", () => {
    const attribution = readSignupAttribution(
      "?source=Landing_Hero&cta=create_account&target_url=https://private.example"
    )
    expect(attribution).toEqual({ source: "landing_hero", cta: "create_account" })
    expect(signupErrorUrl(attribution)).toBe("/sign-up?source=landing_hero&cta=create_account")
    expect(readSignupAttribution(`?source=${"a".repeat(65)}&cta=%2Fbad`)).toEqual({
      source: undefined,
      cta: undefined,
    })
  })
  it("carries bounded UTM and landing-route context (no raw URLs)", () => {
    const attribution = readSignupAttribution(
      "?source=lite_check&cta=review_app&utm_source=LinkedIn&utm_medium=social&utm_campaign=launch&utm_content=post1&from=scan&target=url&returnTo=https://evil.example"
    )
    expect(attribution).toEqual({
      source: "lite_check",
      cta: "review_app",
      utmSource: "linkedin",
      utmMedium: "social",
      utmCampaign: "launch",
      utmContent: "post1",
      landingRoute: "scan",
      targetTypeHint: "url",
    })
    // No raw URLs or arbitrary routes may survive — returnTo is dropped entirely.
    expect(attribution).not.toHaveProperty("returnTo")
    expect(readSignupAttribution("?from=https://evil.example&target=repo")).toEqual({
      landingRoute: undefined,
      targetTypeHint: undefined,
    })
    expect(readSignupAttribution("?from=%2F%2Fevil&target=api")).toEqual({
      landingRoute: undefined,
      targetTypeHint: "api",
    })
  })
  it("serializes acquisition context into the durable-claim payload", () => {
    const attribution = readSignupAttribution(
      "?source=landing_hero&cta=review_app&utm_source=devto&from=pricing"
    )
    expect(acquisitionCookieValue(attribution)).toContain("utmSource")
    expect(acquisitionCookieValue(attribution)).toContain("landingRoute")
    expect(acquisitionCookieValue({})).toBeNull()
  })
})
