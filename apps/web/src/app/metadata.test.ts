import { describe, expect, it, vi } from "vitest"

// The root layout pulls in fonts, global CSS and client providers; the
// metadata export under test is a plain object, so every side-effect import
// is mocked — same approach as dashboard-metadata.test.ts.
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-sans" }),
}))
vi.mock("next/headers", () => ({
  headers: async () => new Map(),
}))
vi.mock("@/components/theme-provider", () => ({ ThemeProvider: () => null }))
vi.mock("@/components/ui/tooltip", () => ({ TooltipProvider: () => null }))
vi.mock("@/components/posthog-provider", () => ({ PostHogProvider: () => null }))
vi.mock("@/components/browser-error-monitor", () => ({ BrowserErrorMonitorGate: () => null }))
vi.mock("./globals.css", () => ({}))

import { metadata } from "./layout"

describe("root app metadata", () => {
  it("defaults the do-not-index host to noindex, nofollow and noarchive", () => {
    // The host's robots.txt disallows all crawling, but a crawler that never
    // fetches robots directives can still index URLs it already knows. A root
    // default covers routes without their own robots field (e.g. /buy/local);
    // per-route declarations still override it where they exist.
    expect(metadata.robots).toMatchObject({ index: false, follow: false, noarchive: true })
  })

  it("describes bounded evidence instead of claiming verified vulnerabilities", () => {
    const description = String(metadata.description)
    expect(description).not.toContain("verifies real vulnerabilities")
    expect(description).toContain("evidence states")
    // Open Graph carries the same bounded copy for social shares.
    expect(String(metadata.openGraph?.description)).toBe(description)
  })
})
