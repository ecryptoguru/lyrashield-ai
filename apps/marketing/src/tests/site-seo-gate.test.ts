import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  REQUIRED_ROBOTS_AGENTS,
  applyBaseline,
  buildBaseline,
  expectedCanonical,
  isBlogPostPath,
  pageViolations,
  titleLimitFor,
} from "../../scripts/crawl-built-site.mjs"
import { INDEXNOW_KEY } from "../../scripts/indexnow.mjs"

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
    jsonLdTypes: ["Organization", "WebSite", "WebPage"],
    jsonLdErrors: [],
    hasDraftMarker: false,
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
    ["og-image-missing", { ogImage: "" }],
    ["og-image-dimensions-missing", { ogImageHeight: "" }],
    ["canonical-mismatch", { canonical: `${ORIGIN}/wrong` }],
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

describe("machine-readable surface contracts", () => {
  it("names every required retrieval agent in robots.txt", () => {
    const robots = source("../pages/robots.txt.ts")
    for (const agent of REQUIRED_ROBOTS_AGENTS) {
      expect(robots, `${agent} must be named explicitly`).toContain(`"${agent}"`)
    }
  })

  it("hosts the IndexNow key file the submission script declares", () => {
    const keyFile = source(`../../public/${INDEXNOW_KEY}.txt`).trim()
    expect(keyFile).toBe(INDEXNOW_KEY)
    expect(INDEXNOW_KEY).toMatch(/^[a-f0-9]{32}$/)
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
