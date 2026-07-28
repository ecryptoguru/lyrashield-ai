import { describe, expect, it } from "vitest"
import { sanitizeProperties, EVENT_ALLOWLIST, track } from "./analytics"

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
    const result = sanitizeProperties("github_connected", {
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
    expect(result).toEqual({})
  })

  it("returns null when no properties remain", () => {
    const result = sanitizeProperties("run_started", { unknown: "value" })
    expect(result).toBeNull()
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
})
