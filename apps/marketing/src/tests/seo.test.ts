import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseJsonc } from "../lib/jsonc"
import { tools } from "../lib/tools"

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

describe("marketing SEO metadata", () => {
  it("gives every free tool unique, intent-specific search metadata", () => {
    expect(new Set(tools.map((tool) => tool.seoTitle)).size).toBe(tools.length)
    expect(new Set(tools.map((tool) => tool.description)).size).toBe(tools.length)

    for (const tool of tools) {
      expect(tool.seoTitle.length).toBeGreaterThanOrEqual(35)
      expect(tool.seoTitle.length).toBeLessThanOrEqual(60)
      expect(tool.description.length).toBeGreaterThanOrEqual(120)
      expect(tool.description.length).toBeLessThanOrEqual(160)
      expect(tool.checks).toHaveLength(3)
      expect(tool.limitations).toHaveLength(3)
      expect(tool.references.length).toBeGreaterThan(0)
    }
  })

  it("keeps indexable pages eligible for full previews while gating pre-launch builds", () => {
    const seoHead = source("../components/SeoHead.astro")

    expect(seoHead).toContain('content="noindex, nofollow"')
    expect(seoHead).toContain('content="noindex, follow"')
    expect(seoHead).toContain(
      'content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"'
    )
  })

  it("keeps Cloudflare asset URLs aligned with no-trailing-slash canonicals", () => {
    const wranglerConfig = source("../../wrangler.jsonc")
    const parsed = parseJsonc<{
      vars: { PUBLIC_SITE_URL: string; PUBLIC_INDEXABLE: string }
    }>(wranglerConfig)

    expect(wranglerConfig).toContain('"html_handling": "drop-trailing-slash"')
    expect(parsed.vars.PUBLIC_SITE_URL).toBe("https://lyrashieldai.com")
    expect(parsed.vars.PUBLIC_INDEXABLE).toBe("true")
  })

  it("captures privacy-bounded PostHog page lifecycle events without query or fragment data", () => {
    const base = source("../layouts/Base.astro")

    expect(base).toContain("capture_pageview: false")
    expect(base).toContain("capture_pageleave: true")
    expect(base).toContain("disable_scroll_properties: false")
    expect(base).toContain('posthog.capture("$pageview"')
    expect(base).toContain("privacyBoundedPageUrl")
    expect(base).toContain("before_send:")
    expect(base).toContain('"$current_url", "$referrer", "$initial_referrer", "referrer"')
    expect(base).not.toContain("$current_url: location.href")
  })

  it("indexes the ready marketing surface without exposing unavailable scanner routes", () => {
    const config = source("../../astro.config.mjs")
    const scanner = source("../pages/scan.astro")
    const terms = source("../pages/terms.astro")

    expect(config).toContain('pathname !== "/terms"')
    expect(config).toContain('pathname !== "/scan"')
    expect(config).toContain("when the public scanner is enabled")
    expect(scanner).toContain("noindex={!scannerAvailable}")
    expect(terms).toMatch(/<Base[^>]+noindex/s)
  })

  it("uses one page-level main landmark and visible structured-data counterparts", () => {
    const methodology = source("../pages/methodology.astro")
    const toolLayout = source("../layouts/ToolLayout.astro")

    expect(methodology).not.toMatch(/<main(?:\s|>)/)
    expect(methodology).toContain('"@type": "WebPage"')
    expect(methodology).toContain('aria-label="Breadcrumb"')
    expect(toolLayout).toContain('"@type": "BreadcrumbList"')
    expect(toolLayout).toContain('aria-label="Breadcrumb"')
    expect(toolLayout).toContain("tool.checks.map")
    expect(toolLayout).toContain("tool.limitations.map")
    expect(toolLayout).toContain('target="_blank"')
    expect(toolLayout).toContain("opens in a new tab")
  })
})
