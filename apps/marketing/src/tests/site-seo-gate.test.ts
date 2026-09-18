import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { allRoutes } from "../../scripts/redirects-lib.mjs"
import {
  LLMS_EXCLUDED_PATHS,
  REQUIRED_ROBOTS_AGENTS,
  SITEMAP_FILTER_EXCLUSIONS,
  applyBaseline,
  buildBaseline,
  crawlBuiltSite,
  expectedCanonical,
  isBlogPostPath,
  pageViolations,
  siteViolations,
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
    mailtoLinks: [],
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

  it("reads no page entries out of a sitemap index", () => {
    // The index carries <sitemap> blocks, not <url> blocks. A rule fed the
    // index sees nothing and silently never fires, which is exactly how the
    // lastmod rule shipped dead once.
    const index = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://lyrashieldai.com/sitemap-0.xml</loc></sitemap>
    </sitemapindex>`
    expect(sitemapEntries(index)).toEqual([])
  })

  it("reports an unreachable robots.txt instead of skipping the agent check", () => {
    const violations = siteViolations({
      pageFacts: new Map(),
      origin: ORIGIN,
      robots: null,
      llms: "https://lyrashieldai.com/",
      rss: "<rss></rss>",
      securityTxt: "Contact: mailto:x@example.com",
    })
    expect(violations.violations.map((v) => v.rule)).toContain("robots-missing")
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

/**
 * End-to-end gate probes over a synthetic built site (review findings F3/F4).
 *
 * The fake serves the whole route inventory through a local origin while the
 * sitemap advertises production locs — exactly what `pnpm preview` looks like
 * in CI. That is what exposed both defects: links were classified against the
 * fetch origin, so production-absolute internal links were never checked, and
 * a failed child sitemap could pass unnoticed behind a healthy sibling.
 */
describe("site gate transport/origin probes", () => {
  const LOCAL = "http://localhost:8787"
  const SITE = ORIGIN

  function healthyPage(path: string, extra = ""): string {
    return `<html lang="en"><head>
      <title>Page ${path}</title>
      <meta name="description" content="Description for ${path}">
      <link rel="canonical" href="${SITE}${path}">
      <meta property="og:image" content="${SITE}/og/page.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <script type="application/ld+json">{"@type":"WebPage"}</script>
      <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    </head><body><main><h1>Heading ${path}</h1>${extra}</main></body></html>`
  }

  const sitemapRoutes = () =>
    allRoutes().filter(
      (route) => !SITEMAP_FILTER_EXCLUSIONS.has(route) && !/^\/blog\/[1-9]\d*$/.test(route)
    )

  interface FakeSite {
    store: Map<string, { status: number; body: string }>
    requests: string[]
    fetchImpl: typeof fetch
  }

  /** A fake site that satisfies every gate rule; tests then break one thing. */
  function buildFakeSite({
    extraRoutes = [] as string[],
    pageOverrides = new Map<string, string>(),
    omitRoutes = new Set<string>(),
  } = {}): FakeSite {
    const routes = ["/", ...sitemapRoutes(), ...extraRoutes].filter((r) => !omitRoutes.has(r))
    const store = new Map<string, { status: number; body: string }>()
    store.set("/sitemap-index.xml", {
      status: 200,
      body: `<sitemapindex><sitemap><loc>${SITE}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    })
    store.set("/sitemap-0.xml", {
      status: 200,
      body: `<urlset>${routes
        .map((r) => `<url><loc>${SITE}${r}</loc><lastmod>2026-09-18</lastmod></url>`)
        .join("")}</urlset>`,
    })
    for (const route of routes) {
      store.set(route, { status: 200, body: pageOverrides.get(route) ?? healthyPage(route) })
    }
    store.set("/robots.txt", {
      status: 200,
      body: REQUIRED_ROBOTS_AGENTS.map((a) => `User-agent: ${a}\nAllow: /`).join("\n"),
    })
    store.set("/llms.txt", {
      status: 200,
      body: routes
        .filter((r) => !LLMS_EXCLUDED_PATHS.has(r))
        .map((r) => `${SITE}${r}`)
        .join("\n"),
    })
    store.set("/rss.xml", { status: 200, body: "<rss></rss>" })
    store.set("/.well-known/security.txt", { status: 200, body: "Expires: 2030-01-01" })
    store.set("/og/page.png", { status: 200, body: "png-bytes" })

    const requests: string[] = []
    const fetchImpl = (async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      requests.push(url)
      const record = store.get(new URL(url).pathname)
      return new Response(record?.body ?? "not found", { status: record?.status ?? 404 })
    }) as typeof fetch
    return { store, requests, fetchImpl }
  }

  const rules = (result: Awaited<ReturnType<typeof crawlBuiltSite>>) =>
    result.violations.map((v) => v.rule)

  it("passes a fully healthy fake site", async () => {
    const { fetchImpl } = buildFakeSite()
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toEqual([])
    expect(result.siteOrigin).toBe(SITE)
    expect(result.pageCount).toBeGreaterThan(200)
  })

  it("checks a broken production-absolute internal link instead of skipping it", async () => {
    const pageOverrides = new Map([
      ["/pricing", healthyPage("/pricing", `<a href="${SITE}/broken">x</a>`)],
    ])
    const { fetchImpl, requests } = buildFakeSite({ pageOverrides })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toContainEqual({
      rule: "internal-link-broken",
      path: "/broken",
      detail: "404",
    })
    // The same-site request is mapped back to the preview — production is
    // never contacted, and genuinely external URLs stay outside the gate.
    expect(requests).toContain(`${LOCAL}/broken`)
    expect(requests.every((url) => url.startsWith(LOCAL))).toBe(true)
  })

  it("fails a cross-page fragment that resolves to a missing id", async () => {
    const pageOverrides = new Map([
      ["/p0", healthyPage("/p0", `<a href="${SITE}/p1#absent">x</a>`)],
    ])
    const { fetchImpl } = buildFakeSite({ extraRoutes: ["/p0", "/p1"], pageOverrides })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toContainEqual({
      rule: "anchor-missing",
      path: "/p0",
      detail: "#absent on /p1",
    })
  })

  it("accepts valid cross-page and encoded fragments", async () => {
    const pageOverrides = new Map([
      ["/p0", healthyPage("/p0", `<a href="${SITE}/p1#caf%C3%A9">x</a>`)],
      ["/p1", healthyPage("/p1", `<h2 id="café">café</h2>`)],
    ])
    const { fetchImpl } = buildFakeSite({ extraRoutes: ["/p0", "/p1"], pageOverrides })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toEqual([])
  })

  it("leaves genuinely external links outside the internal-link gate", async () => {
    const pageOverrides = new Map([
      ["/pricing", healthyPage("/pricing", `<a href="https://example.com/gone">x</a>`)],
    ])
    const { fetchImpl, requests } = buildFakeSite({ pageOverrides })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(rules(result)).not.toContain("internal-link-broken")
    expect(requests.every((url) => url.startsWith(LOCAL))).toBe(true)
  })

  it("fails when an advertised child sitemap cannot be fetched", async () => {
    const { store, fetchImpl } = buildFakeSite()
    store.set("/sitemap-index.xml", {
      status: 200,
      body: `<sitemapindex><sitemap><loc>${SITE}/sitemap-0.xml</loc></sitemap><sitemap><loc>${SITE}/sitemap-1.xml</loc></sitemap></sitemapindex>`,
    })
    store.set("/sitemap-1.xml", { status: 503, body: "" })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toContainEqual({
      rule: "sitemap-fetch",
      path: "/sitemap-1.xml",
      detail: "503",
    })
    // The healthy child still covered everything — the failure is reported on
    // its own, not hidden inside page counts.
    expect(result.pageCount).toBeGreaterThan(200)
  })

  it("fails an advertised child sitemap that is empty or malformed", async () => {
    for (const body of ["<urlset></urlset>", "this is not xml at all"]) {
      const { store, fetchImpl } = buildFakeSite()
      store.set("/sitemap-index.xml", {
        status: 200,
        body: `<sitemapindex><sitemap><loc>${SITE}/sitemap-0.xml</loc></sitemap><sitemap><loc>${SITE}/sitemap-1.xml</loc></sitemap></sitemapindex>`,
      })
      store.set("/sitemap-1.xml", { status: 200, body })
      const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
      expect(rules(result), `body: ${body}`).toContain("sitemap-no-locations")
    }
  })

  it("fails a real route that never reaches the sitemap", async () => {
    const { fetchImpl } = buildFakeSite({ omitRoutes: new Set(["/pricing"]) })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toContainEqual({
      rule: "route-not-in-sitemap",
      path: "/pricing",
      detail: "",
    })
  })

  it("fails a named robots agent whose group disallows everything", async () => {
    const { store, fetchImpl } = buildFakeSite()
    store.set("/robots.txt", {
      status: 200,
      body: `${REQUIRED_ROBOTS_AGENTS.map((a) => `User-agent: ${a}\nAllow: /`).join("\n\n")}\n\nUser-agent: GPTBot\nDisallow: /\n`,
    })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(result.violations).toContainEqual({
      rule: "robots-agent-disallowed",
      path: "/robots.txt",
      detail: "GPTBot",
    })
  })

  it("accepts a named robots agent with a scoped disallow", async () => {
    const { store, fetchImpl } = buildFakeSite()
    store.set("/robots.txt", {
      status: 200,
      body: `${REQUIRED_ROBOTS_AGENTS.map((a) => `User-agent: ${a}\nAllow: /`).join("\n\n")}\n\nUser-agent: GPTBot\nDisallow: /internal\n`,
    })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(rules(result)).not.toContain("robots-agent-disallowed")
  })

  it("fails security.txt without a valid future Expires field", async () => {
    for (const body of [
      "Contact: mailto:x@example.com",
      "Expires: 2001-01-01T00:00:00.000Z",
      "Expires: eventually",
    ]) {
      const { store, fetchImpl } = buildFakeSite()
      store.set("/.well-known/security.txt", { status: 200, body })
      const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
      expect(rules(result), `body: ${body}`).toContain("security-txt-expires")
    }
  })

  it("fetches each advertised same-origin og:image once and fails the unreachable", async () => {
    const { store, fetchImpl, requests } = buildFakeSite()
    store.delete("/og/page.png")
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(rules(result)).toContain("og-image-unreachable")
    // ~260 pages share one card — the dedupe keeps it to a single fetch.
    expect(requests.filter((url) => url === `${LOCAL}/og/page.png`)).toHaveLength(1)
  })

  it("leaves off-origin og:image URLs to their metadata checks", async () => {
    const pageOverrides = new Map([
      ["/pricing", healthyPage("/pricing").replace(`${SITE}/og/page.png`, "https://cdn.example.com/x.png")],
    ])
    const { fetchImpl, requests } = buildFakeSite({ pageOverrides })
    const result = await crawlBuiltSite({ origin: LOCAL, fetchImpl })
    expect(rules(result)).not.toContain("og-image-unreachable")
    expect(requests.every((url) => url.startsWith(LOCAL))).toBe(true)
  })
})
