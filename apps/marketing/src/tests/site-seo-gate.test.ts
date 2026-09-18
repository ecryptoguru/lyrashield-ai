import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { allRoutes } from "../../scripts/redirects-lib.mjs"
import {
  REQUIRED_ROBOTS_AGENTS,
  applyBaseline,
  buildBaseline,
  expectedCanonical,
  isBlogPostPath,
  pageViolations,
  sitemapEntries,
  titleLimitFor,
} from "../../scripts/crawl-built-site.mjs"
import { readIndexNowKey, submitToIndexNow } from "../../scripts/indexnow.mjs"
import { DEFAULT_OG_IMAGE, OG_CARD_PATHS, ogImageFor } from "../lib/og-images"

const ORIGIN = "https://lyrashieldai.com"

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

/** Facts for a page that violates nothing, so each test can break one field. */
function healthyFacts(path = "/pricing", overrides: Record<string, unknown> = {}) {
  return {
    title: "A short, unique title",
    description: "A description that stays inside the length budget.",
    noindex: false,
    canonical: expectedCanonical(ORIGIN, path),
    canonicalCount: 1,
    h1Count: 1,
    mainCount: 1,
    ids: new Set<string>(),
    hrefs: [],
    localHrefs: [],
    tagUrls: [],
    anchorTargets: [],
    anchorErrors: [],
    imageUrls: [],
    ogImage: `${ORIGIN}/og/pricing.png`,
    ogImageWidth: "1200",
    ogImageHeight: "630",
    jsonLdCount: 1,
    jsonLdTypes: ["Organization", "WebSite", "WebPage", "BreadcrumbList"],
    jsonLdErrors: [],
    hasDraftMarker: false,
    imagesMissingAlt: 0,
    htmlLang: "en",
    ...overrides,
  }
}

describe("site SEO gate rules", () => {
  it("budgets blog post titles above static page titles", () => {
    expect(isBlogPostPath("/blog/some-post")).toBe(true)
    expect(isBlogPostPath("/blog/editorial-policy")).toBe(false)
    expect(isBlogPostPath("/blog/tags/access-control")).toBe(false)
    expect(isBlogPostPath("/blog/2")).toBe(false)
    expect(titleLimitFor("/blog/some-post")).toBe(65)
    expect(titleLimitFor("/pricing")).toBe(60)
  })

  it("states the homepage canonical with its trailing slash and every other page without one", () => {
    expect(expectedCanonical(ORIGIN, "/")).toBe(`${ORIGIN}/`)
    expect(expectedCanonical(ORIGIN, "/pricing")).toBe(`${ORIGIN}/pricing`)
  })

  it("accepts a page that meets every rule", () => {
    expect(pageViolations({ path: "/pricing", facts: healthyFacts(), origin: ORIGIN })).toEqual([])
  })

  it.each([
    ["title-too-long", { title: "x".repeat(61) }],
    ["description-too-long", { description: "x".repeat(161) }],
    ["title-missing", { title: "" }],
    ["description-missing", { description: "" }],
    ["h1-count", { h1Count: 2 }],
    ["main-count", { mainCount: 0 }],
    ["noindex-in-sitemap", { noindex: true }],
    ["jsonld-missing", { jsonLdCount: 0, jsonLdTypes: [] }],
    ["jsonld-page-entity-missing", { jsonLdTypes: ["Organization", "WebSite"] }],
    ["jsonld-breadcrumb-missing", { jsonLdTypes: ["Organization", "WebSite", "WebPage"] }],
    ["og-image-missing", { ogImage: "" }],
    ["og-image-dimensions-missing", { ogImageHeight: "" }],
    ["canonical-mismatch", { canonical: `${ORIGIN}/wrong` }],
    ["html-lang-missing", { htmlLang: "" }],
    ["img-alt-missing", { imagesMissingAlt: 2 }],
  ])("reports %s", (rule, overrides) => {
    const violations = pageViolations({
      path: "/pricing",
      facts: healthyFacts("/pricing", overrides),
      origin: ORIGIN,
    })
    expect(violations.map((violation) => violation.rule)).toContain(rule)
  })

  it("allows the shared default OG card on blog posts but not on landing pages", () => {
    const defaultCard = { ogImage: `${ORIGIN}/og/og-default.png` }
    expect(
      pageViolations({
        path: "/blog/some-post",
        facts: healthyFacts("/blog/some-post", defaultCard),
        origin: ORIGIN,
      })
    ).toEqual([])
    expect(
      pageViolations({
        path: "/pricing",
        facts: healthyFacts("/pricing", defaultCard),
        origin: ORIGIN,
      }).map((violation) => violation.rule)
    ).toContain("og-image-default")
  })

  it("keeps the baseline honest about what it pins and what it no longer covers", () => {
    const violations = [
      { rule: "title-too-long", path: "/a", detail: "" },
      { rule: "title-too-long", path: "/b", detail: "" },
    ]
    const baseline = buildBaseline(violations, { date: "2026-09-18", notes: {} })
    expect(baseline.entries).toEqual([
      { rule: "title-too-long", path: "/a" },
      { rule: "title-too-long", path: "/b" },
    ])

    const result = applyBaseline(violations, {
      entries: [
        { rule: "title-too-long", path: "/a" },
        { rule: "og-image-default", path: "/gone" },
      ],
    })
    expect(result.fresh.map((violation) => violation.path)).toEqual(["/b"])
    expect(result.baselined.map((violation) => violation.path)).toEqual(["/a"])
    expect(result.stale).toEqual([["og-image-default", "/gone"]])
  })
})

describe("social cards", () => {
  it("ships every card the map points at", () => {
    for (const card of OG_CARD_PATHS) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(existsSync(new URL(`../../public${card}`, import.meta.url)), card).toBe(true)
    }
  })

  it("gives every built route a section card instead of the fallback", () => {
    // /terms and /terms-of-sale are noindex and outside the sitemap, so they
    // keep the neutral fallback card; every indexed route gets a section card.
    const noindexRoutes = new Set(["/terms", "/terms-of-sale"])
    for (const route of allRoutes()) {
      if (noindexRoutes.has(route)) continue
      // Blog posts pass their own per-post image; the tag hubs and the hub
      // itself use the section card.
      expect(ogImageFor(route), `${route} must not fall back to the default card`).not.toBe(
        DEFAULT_OG_IMAGE
      )
    }
  })

  it("resolves the section card by longest path prefix", () => {
    expect(ogImageFor("/")).toBe("/og/home.png")
    expect(ogImageFor("/pricing")).toBe("/og/pricing.png")
    expect(ogImageFor("/docs/integrations/zed")).toBe("/og/docs.png")
    expect(ogImageFor("/blog/tags/verification")).toBe("/og/blog.png")
    expect(ogImageFor("/support")).toBe("/og/company.png")
    expect(ogImageFor("/not-a-real-page")).toBe(DEFAULT_OG_IMAGE)
  })
})

describe("machine-readable surface contracts", () => {
  it("reads lastmod per sitemap URL", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://lyrashieldai.com/pricing</loc><lastmod>2026-09-18</lastmod></url>
      <url><loc>https://lyrashieldai.com/demo</loc></url>
    </urlset>`
    expect(sitemapEntries(xml)).toEqual([
      { path: "/pricing", lastmod: "2026-09-18" },
      { path: "/demo", lastmod: "" },
    ])
  })

  it("names every required retrieval agent in robots.txt", () => {
    const robots = source("../pages/robots.txt.ts")
    for (const agent of REQUIRED_ROBOTS_AGENTS) {
      expect(robots, `${agent} must be named explicitly`).toContain(`"${agent}"`)
    }
  })

  it("resolves the IndexNow key from the file the protocol serves", async () => {
    // The key is public by design (IndexNow fetches it from the site), but it
    // must not exist as a source literal: gitleaks cannot tell a hosted
    // verification token from a leaked credential.
    const key = await readIndexNowKey()
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    expect(source(`../../public/${key}.txt`).trim()).toBe(key)
    expect(source("../../scripts/indexnow.mjs")).not.toContain(key)
  })

  it("derives the IndexNow host from the sitemap, not from the origin it fetched", async () => {
    // A local preview serves a build whose sitemap points at production, so
    // filtering by the fetch origin would silently submit nothing.
    const key = await readIndexNowKey()
    const responses = new Map([
      [
        "http://127.0.0.1:8787/sitemap-index.xml",
        "<sitemapindex><sitemap><loc>https://lyrashieldai.com/sitemap-0.xml</loc></sitemap></sitemapindex>",
      ],
      [
        "http://127.0.0.1:8787/sitemap-0.xml",
        "<urlset>" +
          "<url><loc>https://lyrashieldai.com/a</loc></url>" +
          "<url><loc>https://lyrashieldai.com/b</loc></url>" +
          "</urlset>",
      ],
      [`http://127.0.0.1:8787/${key}.txt`, key],
    ])
    const fetchImpl = async (input: URL | RequestInfo): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body = responses.get(url)
      return new Response(body ?? "", { status: body === undefined ? 404 : 200 })
    }

    const result = await submitToIndexNow({
      origin: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      dryRun: true,
    })
    expect(result).toEqual({ host: "lyrashieldai.com", submitted: 2, status: 0 })
  })

  it("keeps the security.txt contact pointed at a monitored mailbox", () => {
    const securityTxt = source("../../public/.well-known/security.txt")
    expect(securityTxt).toContain("Contact: mailto:security@lyrashieldai.com")
    expect(securityTxt).toContain("Policy: https://lyrashieldai.com/security-reporting")
  })

  it("keeps the RSS feed slash-less to match the site canonicals", () => {
    expect(source("../pages/rss.xml.ts")).toContain("trailingSlash: false")
  })

  it("redirects /blog/1 to the blog hub instead of serving a 404", () => {
    expect(source("../middleware.ts")).toContain('"/blog/1": "/blog"')
  })
})
