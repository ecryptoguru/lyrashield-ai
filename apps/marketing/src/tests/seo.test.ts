import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseJsonc } from "../lib/jsonc"
import { tools } from "../lib/tools"

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

describe("marketing SEO metadata", () => {
  it("does not publish or link the retired sample report", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(new URL("../pages/sample-report.astro", import.meta.url))).toBe(false)

    const publicNavigation = [
      source("../components/Footer.astro"),
      source("../components/landing/PremiumHero.astro"),
      source("../components/landing/FinalCta.astro"),
      source("../lib/motion-manifest.ts"),
      source("../pages/llms.txt.ts"),
      source("../pages/scan.astro"),
    ].join("\n")
    expect(publicNavigation).not.toContain("/sample-report")
  })

  it("gives every free tool unique, intent-specific search metadata", () => {
    const aiAppSecurityScanner = tools.find((tool) => tool.slug === "ai-app-security-scanner")
    expect(aiAppSecurityScanner, "AI App Security scanner must be registered").toBeDefined()
    if (aiAppSecurityScanner) {
      expect(aiAppSecurityScanner.category).toBe("Protect data and access")
      expect(aiAppSecurityScanner.privacy).toContain("never leave your device")
    }

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
    expect(seoHead).toContain('type="application/rss+xml"')
    expect(seoHead).toContain('href="/llms.txt"')
    expect(seoHead).toContain('property="og:image:alt"')
  })

  it("publishes citation-ready homepage entities and current evidence definitions", () => {
    const home = source("../pages/index.astro")
    const methodology = source("../pages/methodology.astro")
    const llms = source("../pages/llms.txt.ts")

    expect(home).toContain('"@type": "WebPage"')
    expect(home).toContain('"@id": `${pageUrl}#application`')
    expect(home).toContain('"@id": `${pageUrl}#faq`')
    expect(home).toContain('inLanguage: "en-US"')
    expect(methodology).toContain('dateModified: "2026-07-29"')
    // The 43/7 split is derived from the same control registry
    // vibe-security-50.astro builds its own counts from, not a hardcoded
    // literal here — hardcoding it as separate prose would let this file
    // silently disagree with the page it summarizes the moment the control
    // list changes. Assert the registry wiring instead of a fixed string:
    // the relative import (not the "@lyrashield/security" package alias,
    // which pulls in undici and breaks the Cloudflare Worker bundle — see
    // the identical guard in vibe-security-50.astro) and the computed counts
    // actually appearing in the rendered sentence.
    expect(llms).toContain(
      'import { VIBE_SECURITY_CONTROLS } from "../../../../packages/security/src/vibe-security-controls"'
    )
    expect(llms).not.toContain('from "@lyrashield/security"')
    expect(llms).toContain("reviewControlCount")
    expect(llms).toContain("evidenceControlCount")
    expect(llms).toContain("controls are routed to code or URL review where applicable and")
    expect(llms).toContain("require operational or human evidence outside the scan")
    expect(llms).toContain("`${origin}/vibe-security-50`")
    expect(llms).toContain('"/docs/integrations/goose"')
    expect(llms).not.toContain("`${origin}/scan`")
  })

  it("publishes every llms.txt public URL as a descriptive Markdown link", () => {
    const llms = source("../pages/llms.txt.ts")

    expect(llms).toContain(
      "const markdownLink = (label: string, url: string) => `[${label}](${url})`"
    )
    expect(llms).toContain("const publicLinks = [")
    expect(llms).toContain("...publicLinks.map(({ label, url }) => markdownLink(label, url))")
    expect(llms).toContain('markdownLink("Create a free LyraShield AI account"')
    expect(llms).toContain('markdownLink("LyraShield AI source code on GitHub"')
    expect(llms).not.toContain("const publicPaths = [")
  })

  it("updates llms.txt freshness only through its manual content date", () => {
    const llms = source("../pages/llms.txt.ts")

    expect(llms).toContain('const LLMS_TXT_CONTENT_DATE = "2026-08-24"')
    expect(llms).toContain("Bump this by hand only when a section's CONTENT changes")
    expect(llms).not.toMatch(/LLMS_TXT_CONTENT_DATE\s*=\s*new Date/)
  })

  it("keeps the 100-post blog surface crawlable, attributable, and draft-gated", () => {
    const index = source("../pages/blog/[...page].astro")
    const post = source("../layouts/BlogPost.astro")
    const tag = source("../pages/blog/tags/[tag].astro")
    const card = source("../components/BlogCard.astro")
    const footer = source("../components/Footer.astro")

    expect(index).toContain('"@type": "CollectionPage"')
    expect(index).toContain('"@type": "ItemList"')
    expect(index).toContain("!entry.data.draft")
    expect(index).not.toContain("import.meta.env.DEV || !entry.data.draft")
    expect(index).toContain('rel="prev"')
    expect(index).toContain('rel="next"')
    expect(tag).toContain('"@type": "BreadcrumbList"')
    expect(tag).toContain('"@type": "ItemList"')
    expect(post).toContain('"@type": "BlogPosting"')
    expect(post).toContain("wordCount")
    expect(post).toContain("timeRequired")
    expect(post).toContain('"@type": author.data.kind')
    expect(post).toContain("author.data.bio")
    expect(post).toContain("author.data.profileUrl")
    expect(post).toContain("heroImage.data.og")
    expect(post).toContain('class="blog-post__mobile-toc"')
    expect(card).toContain("<picture")
    expect(card).toContain('loading="lazy"')
    expect(card).toContain('aria-label="Topics"')
    expect(footer).toContain('href: "/blog"')
  })

  it("keeps Cloudflare asset URLs aligned with no-trailing-slash canonicals", () => {
    const wranglerConfig = source("../../wrangler.jsonc")
    const middleware = source("../middleware.ts")
    const redirects = source("../../public/_redirects")
    const parsed = parseJsonc<{
      vars: { PUBLIC_SITE_URL: string; PUBLIC_APP_URL: string; PUBLIC_INDEXABLE: string }
    }>(wranglerConfig)

    expect(wranglerConfig).toContain('"html_handling": "drop-trailing-slash"')
    expect(parsed.vars.PUBLIC_SITE_URL).toBe("https://lyrashieldai.com")
    expect(parsed.vars.PUBLIC_APP_URL).toBe("https://app.lyrashieldai.com")
    expect(parsed.vars.PUBLIC_INDEXABLE).toBe("true")
    for (const [pathname, target] of [
      ["/docs", "/docs/integrations"],
      ["/resources", "/blog"],
      ["/how-it-works", "/#how-it-works"],
      ["/docs/integrations/windsurf", "/docs/integrations/devin"],
    ]) {
      expect(redirects).toContain(`${pathname} ${target} 301`)
      expect(middleware).toContain(`${JSON.stringify(pathname)}: ${JSON.stringify(target)}`)
    }
    expect(middleware).toContain("status: 301")
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
    const termsOfSale = source("../pages/terms-of-sale.astro")

    expect(config).toContain('pathname !== "/terms"')
    expect(config).toContain('pathname !== "/terms-of-sale"')
    expect(config).toContain('pathname !== "/docs"')
    expect(config).toContain('pathname !== "/scan"')
    expect(config).toContain("when the public scanner is enabled")
    expect(scanner).toContain("noindex={!scannerAvailable}")
    expect(terms).toMatch(/<Base[^>]+noindex/s)
    expect(termsOfSale).toMatch(/<Base[^>]+noindex/s)
  })

  it("keeps dark product-shot utility text at accessible contrast", () => {
    const productShot = source("../components/ProductShot.astro")
    expect(productShot).toContain("background: #0e1a28")
    expect(productShot).toContain("color: #a7bac9")
    expect(productShot).not.toContain("color: #5f7081")
  })

  it("routes Free scan navigation to the canonical, answer-ready Lite Check page", () => {
    const header = source("../components/Header.astro")
    const premiumHero = source("../components/landing/PremiumHero.astro")
    const scanner = source("../pages/scan.astro")

    expect(header.match(/href="\/scan"/g)).toHaveLength(2)
    expect(header.match(/\$\{appUrl\}\/sign-in/g)).toHaveLength(2)
    expect(header).not.toContain('href="/#free-scan"')
    // The hero primary CTA now jumps to the on-page Lite Check form instead of the
    // canonical page (founder-approved). The canonical page must still be reachable
    // from the homepage, so assert that rather than dropping the guarantee.
    expect(premiumHero).toContain('href="#free-scan" data-cta-id="premium-hero-lite-check"')
    expect(source("../components/landing/HomeLiteScan.astro")).toContain('href="/scan"')
    expect(source("../components/landing/HomeLiteScan.astro")).toContain('action="/scan"')
    expect(source("../components/landing/FinalCta.astro")).toContain('href="/methodology"')
    expect(scanner).toContain(
      'const title = "Free AI App Security Check — Passive URL Scan | LyraShield AI"'
    )
    expect(scanner).toContain(
      'const description = "Run a free, passive URL security check for AI-built apps.'
    )
    expect(scanner).toContain('"@type": "WebApplication"')
    expect(scanner).toContain('"@type": "FAQPage"')
    expect(scanner).toContain('"@type": "BreadcrumbList"')
  })

  it("uses one page-level main landmark and keeps breadcrumbs in metadata only", () => {
    const methodology = source("../pages/methodology.astro")
    const toolLayout = source("../layouts/ToolLayout.astro")
    const breadcrumbSurfaces = [
      methodology,
      toolLayout,
      source("../pages/tools/index.astro"),
      source("../pages/scan.astro"),
      source("../pages/terms.astro"),
      source("../pages/blog/[...page].astro"),
      source("../layouts/BlogPost.astro"),
    ]

    expect(methodology).not.toMatch(/<main(?:\s|>)/)
    expect(methodology).toContain('"@type": "WebPage"')
    expect(toolLayout).toContain('"@type": "BreadcrumbList"')
    breadcrumbSurfaces.forEach((surface) =>
      expect(surface).not.toContain('aria-label="Breadcrumb"')
    )
    expect(toolLayout).toContain("tool.checks.map")
    expect(toolLayout).toContain("tool.limitations.map")
    expect(toolLayout).toContain('target="_blank"')
    expect(toolLayout).toContain("opens in a new tab")
  })

  it("publishes the coding-agent entry in human and machine-readable discovery", () => {
    const llms = source("../pages/llms.txt.ts")
    const agents = source("../pages/agents.astro")
    expect(llms).toContain(
      '`Human-facing setup: ${markdownLink("Coding-agent security", `${origin}/agents`)}'
    )
    expect(llms).toContain('markdownLink("agents.md", `${origin}/agents.md`)')
    expect(agents).toContain('new URL("/agents", origin).toString()')
    expect(agents).toContain("url: `${pageUrl}#setup`")
    expect(agents).toContain("url: `${pageUrl}#clients`")
    expect(agents).toContain("url: `${pageUrl}#safety`")
    expect(agents).not.toContain("noindex")
  })
})
