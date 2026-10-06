import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseJsonc } from "../lib/jsonc"
import { tools } from "../lib/tools"
import { allRoutes, LEGACY_REDIRECTS } from "../../scripts/redirects-lib.mjs"

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

interface RedirectRule {
  source: string
  target: string
  code: string
}

function parseRedirectRules(redirectsFile: string): RedirectRule[] {
  const rules: RedirectRule[] = []
  for (const line of redirectsFile.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 3) rules.push({ source: parts[0], target: parts[1], code: parts[2] })
  }
  return rules
}

describe("marketing SEO metadata", () => {
  it("does not publish or link the retired sample report", () => {
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

  it("emits webmaster verification tags from the documented build config", () => {
    // PUBLIC_GOOGLE_SITE_VERIFICATION / PUBLIC_BING_SITE_VERIFICATION are
    // advertised in wrangler.jsonc vars, which are Worker runtime vars — a
    // build-time import.meta.env read can never see them, so the tag would
    // stay absent even with the documented var set. The codes resolve through
    // the same wranglerVar → vite define path as the other build metadata.
    const config = source("../../astro.config.mjs")
    const seoHead = source("../components/SeoHead.astro")

    expect(config).toContain('wranglerVar("PUBLIC_GOOGLE_SITE_VERIFICATION")')
    expect(config).toContain('wranglerVar("PUBLIC_BING_SITE_VERIFICATION")')
    expect(config).toContain("__MARKETING_GOOGLE_VERIFICATION__")
    expect(config).toContain("__MARKETING_BING_VERIFICATION__")

    expect(seoHead).toContain("const googleVerification = __MARKETING_GOOGLE_VERIFICATION__")
    expect(seoHead).toContain("const bingVerification = __MARKETING_BING_VERIFICATION__")
    expect(seoHead).not.toContain("import.meta.env.PUBLIC_GOOGLE_SITE_VERIFICATION")
    expect(seoHead).not.toContain("import.meta.env.PUBLIC_BING_SITE_VERIFICATION")
    // Both tags exist but only render when configured — never empty placeholders.
    expect(seoHead).toContain('name="google-site-verification"')
    expect(seoHead).toContain('name="msvalidate.01"')
  })

  it("publishes citation-ready homepage entities and current evidence definitions", () => {
    const home = source("../pages/index.astro")
    const methodology = source("../pages/methodology.astro")
    const llms = source("../pages/llms.txt.ts")

    expect(home).toContain('"@type": "WebPage"')
    expect(home).toContain('"@id": `${pageUrl}#application`')
    expect(home).toContain('"@id": `${pageUrl}#faq`')
    expect(home).toContain('inLanguage: "en-US"')
    // Methodology's dateModified is derived from git at build time
    // (src/lib/build-date.ts), not a hardcoded literal.
    expect(methodology).toContain('import { buildDateFor } from "../lib/build-date"')
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

  it("derives llms.txt freshness from content dates, never build time", () => {
    const llms = source("../pages/llms.txt.ts")

    // The date tracks the newest dated content the file summarizes — blog,
    // compare, docs frontmatter, tools registry — floored at the last
    // copy-only change and never `new Date()` (which would claim the whole
    // site changed on every deploy).
    expect(llms).toContain("latestContentDate")
    expect(llms).toContain("LLMS_TXT_DATE_FLOOR")
    expect(llms).not.toMatch(/latestContentDate[\s\S]{0,400}new Date\(\)/)
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

    // Trailing-slash 301s for prerendered pages are asset-layer _redirects
    // rules (asserted below) — the one layer that sees asset-served requests.
    // The platform's drop-trailing-slash 307 only fires for requests that
    // fall through rule matching, so an explicit rule wins. Astro middleware
    // and src/fetch.ts cannot do this: Astro skips middleware for statically
    // rendered routes. The worker's matchStaticAsset short-circuits the
    // pipeline for prerendered pages.
    expect(wranglerConfig).toContain('"html_handling": "drop-trailing-slash"')
    expect(wranglerConfig).not.toContain("run_worker_first")
    // THE invariant, not spot-checks: every enumerated route carries a
    // correct trailing-slash rule and no orphan rules exist outside the
    // explicit permanent aliases in redirects-lib.mjs. The route enumeration
    // is the same source the CI validator and --write regenerator use.
    const redirectsRules = parseRedirectRules(redirects)
    const ruleBySource = new Map(redirectsRules.map((rule) => [rule.source, rule]))
    for (const route of allRoutes()) {
      const rule = ruleBySource.get(`${route}/`)
      expect(rule, `missing trailing-slash rule for ${route}/`).toBeDefined()
      expect(rule?.target, `wrong target for ${route}/`).toBe(route)
      expect(rule?.code, `wrong status for ${route}/`).toBe("301")
    }
    const routeSlashForms = new Set(allRoutes().map((route) => `${route}/`))
    const legacyRedirectSources = new Set(LEGACY_REDIRECTS.map((redirect) => redirect.source))
    for (const rule of redirectsRules) {
      if (rule.source.endsWith("/") && !rule.source.includes("index.html")) {
        expect(
          routeSlashForms.has(rule.source) || legacyRedirectSources.has(rule.source),
          `orphan trailing-slash rule (no such route): ${rule.source}`
        ).toBe(true)
      }
    }
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

  it("binds the live Cloudflare smoke check to the exact marketing build revision", () => {
    const config = source("../../astro.config.mjs")
    const seoHead = source("../components/SeoHead.astro")
    const workflow = source("../../../../.github/workflows/ci.yml")

    expect(config).toContain("process.env.LYRASHIELD_MARKETING_REVISION || process.env.GITHUB_SHA")
    expect(config).toContain("__MARKETING_BUILD_REVISION__: JSON.stringify(buildRevision)")
    expect(seoHead).toContain(
      '<meta name="lyrashield-build-revision" content={__MARKETING_BUILD_REVISION__} />'
    )
    expect(workflow).toContain("LYRASHIELD_MARKETING_REVISION: ${{ github.sha }}")
    expect(workflow).toContain("Generated marketing artifact serves revision ${expected}")
    expect(workflow).toContain('if [ "$live_revision" = "$GITHUB_SHA" ]; then')
  })

  it("captures privacy-bounded PostHog page lifecycle events without query or fragment data", () => {
    const base = source("../layouts/Base.astro")

    expect(base).toContain("capture_pageview: false")
    expect(base).toContain("capture_pageleave: true")
    expect(base).toContain("disable_scroll_properties: false")
    expect(base).toContain("if (!posthogKey || !trackingAllowed() || initializingPosthog) return")
    expect(base).toContain("marketingAnalyticsAllowed")
    expect(base).toContain("accountAnalyticsEnabled")
    expect(base).toContain('"$pageview",')
    expect(base).toContain("posthog.capture(")
    expect(base).toContain('send_instantly: true, transport: "sendBeacon"')
    expect(base).toContain("privacyBoundedPageUrl")
    expect(base).toContain("before_send:")
    expect(base).toContain("privacyBoundedMarketingEvent(event)")
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
      'const title = "Free AI app security check — URL scan | LyraShield AI"'
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

  it("states three shipped evidence states with the fourth marked future-defined", () => {
    const llms = source("../pages/llms.txt.ts")
    const methodology = source("../pages/methodology.astro")
    const home = source("../pages/index.astro")
    const about = source("../pages/about.astro")

    // The audit found llms.txt claiming four states while defining three —
    // the contradiction is what answer engines were reading.
    expect(llms).toContain("three shipped evidence states")
    expect(llms).not.toContain("one of four evidence states")
    expect(llms).toContain("defined, not shipped")
    expect(llms).toContain("No finding carries this state today")

    // Methodology is the fact authority the summary defers to.
    expect(methodology).toContain("ships three today")
    expect(methodology).toContain("not produced today")
    expect(methodology).not.toContain("one of four evidence states")
    expect(methodology).not.toContain("LyraShield uses\n")

    // Everywhere else the states are enumerated must tell the same story.
    expect(home).not.toContain("independently verified findings")
    expect(about).toContain("three shipped states")
    expect(about).not.toContain("one of four states")
  })

  it("never groups the server-fetched Lite Check under browser-local data flow", () => {
    const llms = source("../pages/llms.txt.ts")

    // The Lite Check fetches the authorized URL from LyraShield's server; only
    // the tool registry is browser-local. The audit found both described as
    // "entirely client-side".
    expect(llms).toContain("run entirely client-side")
    expect(llms).toContain("it is not browser-local")
    expect(llms).not.toContain("Lite Check and these")
    expect(llms).not.toMatch(/Lite Check[^\n]*run entirely client-side/)
  })

  it("keeps tool-page trial copy inside the published plan limits", () => {
    const toolLayout = source("../layouts/ToolLayout.astro")

    // Trial is 60 minutes / 3 targets — "run every review layer" overstated
    // coverage on all seven tool pages.
    expect(toolLayout).toContain("run the checks available for your authorized target and plan")
    expect(toolLayout).not.toContain("run every review layer")
  })

  it("drives visible, attribute, schema and sitemap dates from one constant per page", () => {
    const pages = [
      ["../pages/about.astro", "updatedDate"],
      ["../pages/evidence-vault.astro", "reviewed"],
      ["../pages/vibe-security-50.astro", "reviewed"],
      ["../pages/methodology.astro", "reviewed"],
    ] as const
    const config = source("../../astro.config.mjs")
    // Literal patterns keyed by constant name — a dynamic RegExp would trip
    // security/detect-non-literal-regexp even though the inputs are fixed.
    const hardcodedLabel: Record<string, RegExp> = {
      reviewed: /datetime=\{reviewed\}>\s*[A-Z][a-z]+ \d{1,2}, \d{4}/,
      updatedDate: /datetime=\{updatedDate\}>\s*[A-Z][a-z]+ \d{1,2}, \d{4}/,
    }
    const declaration: Record<string, RegExp> = {
      reviewed: /const reviewed = "\d{4}-\d{2}-\d{2}"/,
      updatedDate: /const updatedDate = "\d{4}-\d{2}-\d{2}"/,
    }

    for (const [path, constant] of pages) {
      const page = source(path)
      // One constant feeds every surface; a literal month string inside the
      // <time> element is exactly how the Oct-2026 drift shipped.
      expect(page, `${path} visible <time> must derive from ${constant}`).toContain(
        `datetime={${constant}}`
      )
      expect(page, `${path} must not hardcode the visible date`).not.toMatch(
        hardcodedLabel[constant]
      )
      expect(page, `${path} must declare the constant`).toMatch(declaration[constant])
    }

    // JSON-LD dateModified uses the same constants, and the sitemap lastmod
    // parse in astro.config.mjs reads them rather than a git timestamp.
    expect(source("../pages/about.astro")).toContain("dateModified: updatedDate")
    expect(source("../pages/evidence-vault.astro")).toContain("dateModified: reviewed")
    expect(source("../pages/vibe-security-50.astro")).toContain("dateModified: reviewed")
    expect(config).toContain('["evidence-vault", "/evidence-vault"]')
    expect(config).toContain('["vibe-security-50", "/vibe-security-50"]')
    expect(config).toContain('["about", "/about"]')
    expect(config).toContain("const\\s+(?:reviewed|updatedDate|reviewedDate)")
  })

  it("keeps the founder build log consistent with current product availability", () => {
    const post = source("../content/blog/building-release-assurance-lessons-open-beta.mdx")

    // Paid plans are live; describing billing as roadmap work is the stale
    // claim the audit flagged. The visible correction note keeps the original
    // firsthand framing honest.
    expect(post).toContain("updatedDate: 2026-10-06")
    expect(post).toContain("Update, October 2026")
    expect(post).toContain("paid plans are live")
    expect(post).not.toContain("billing are on our near term roadmap")
    expect(post).not.toContain("billing not yet live")
    // A finding without proof stays a detected candidate — it is never hidden,
    // and a proposal never claims universal reachability or payload proof.
    expect(post).toContain("stays marked as a detected candidate")
    expect(post).not.toContain("If we cannot show evidence, we do not show the finding")
  })

  it("requires paired reviewer and reviewedDate before any review attribution renders", () => {
    const config = source("../content.config.ts")
    const validator = source("../../scripts/blog-validation-lib.mjs")
    const post = source("../layouts/BlogPost.astro")
    const route = source("../pages/blog/[slug].astro")

    // All-or-nothing pairing is enforced in both the collection schema and the
    // offline validator; rendering only happens when both resolve.
    expect(config).toContain("reviewer and reviewedDate must be set together or not at all")
    expect(validator).toContain("reviewer and reviewedDate must be set together or not at all")
    expect(post).toContain("reviewer && reviewedDate")
    expect(post).toContain("Technically reviewed by")
    expect(post).toContain("reviewedBy")
    expect(route).toContain("post.data.reviewer ? getEntry(post.data.reviewer)")
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
