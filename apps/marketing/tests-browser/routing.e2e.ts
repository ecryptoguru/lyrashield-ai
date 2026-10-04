import { expect, test } from "@playwright/test"
import { readdirSync } from "node:fs"

// Routing and freshness regression coverage for the trailing-slash
// canonicalisation work (PR #591 + follow-ups). Every canonical URL on this
// site is slash-less. The 301s for prerendered pages are asset-layer
// _redirects rules — the one layer that sees asset-served requests (Astro
// middleware never runs for statically rendered routes. The worker's
// matchStaticAsset short-circuits the pipeline for prerendered pages). The
// platform's drop-trailing-slash 307 must never appear for paths with an
// explicit rule. Pages must continue to serve 200 with the security headers
// the middleware attaches. dateModified must be present on the pages whose
// freshness is git-derived (the workerd execSync bug dropped it sitewide
// once already).
//
// These run against wrangler dev --local through the Playwright webServer,
// so they exercise the same Worker + ASSETS binding pipeline as production.

test("canonical pages serve 200 with middleware security headers", async ({ page }) => {
  const response = await page.goto("/")
  expect(response?.status()).toBe(200)
  const headers = response?.headers() ?? {}
  expect(headers["x-content-type-options"]).toBe("nosniff")
  expect(headers["x-frame-options"]).toBe("DENY")
  expect(headers["strict-transport-security"]).toContain("max-age=31536000")

  for (const path of [
    "/pricing",
    "/webmcp",
    "/agents",
    "/methodology",
    "/compare/snyk",
    "/tools",
    "/tools/security-headers-checker",
    "/blog",
  ]) {
    const res = await page.request.get(path)
    expect(res.status(), `${path} must serve 200`).toBe(200)
  }
})

test("blog posts still serve after the routing change", async ({ page }) => {
  const res = await page.request.get("/blog/path-traversal-generated-code")
  expect(res.status()).toBe(200)
})

test("trailing-slash URLs redirect 301 to the canonical slash-less URL", async ({ page }) => {
  for (const path of ["/pricing/", "/blog/2/", "/tools/"]) {
    const res = await page.request.get(path, { maxRedirects: 0 })
    expect(res.status(), `${path} must be 301, not the platform 307`).toBe(301)
    expect(res.headers()["location"]).toBe(path.replace(/\/+$/, ""))
  }
})

test("legacy Pi integration URLs redirect permanently to the canonical guide", async ({ page }) => {
  for (const path of ["/docs/integrations/picode", "/docs/integrations/picode/"]) {
    const res = await page.request.get(path, { maxRedirects: 0 })
    expect(res.status(), `${path} must be 301`).toBe(301)
    expect(res.headers()["location"]).toBe("/docs/integrations/pi")
  }
})

test("retired vs-lyrashield posts redirect permanently to their compare page", async ({ page }) => {
  // Wave 8 (D9): the 13 long-form posts were retired and their content folded
  // into the compare page. Both the slashless and the trailing-slash form must
  // reach /compare/<slug>, never the platform 404 or the drop-trailing-slash
  // 307. The slugs are derived from the compare collection so the two lists
  // cannot drift apart.
  const slugs = readdirSync(new URL("../src/content/compare/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort()
  expect(slugs, "the compare program should still be 13 pages").toHaveLength(13)

  for (const slug of slugs) {
    for (const path of [`/blog/${slug}-vs-lyrashield`, `/blog/${slug}-vs-lyrashield/`]) {
      const res = await page.request.get(path, { maxRedirects: 0 })
      expect(res.status(), `${path} must be 301`).toBe(301)
      expect(res.headers()["location"], `${path} target`).toBe(`/compare/${slug}`)
    }
  }
})

test("every retired post URL is gone from the served sitemap and llms.txt", async ({
  page,
  baseURL,
}) => {
  const sitemap = await page.request.get("/sitemap-index.xml")
  expect(sitemap.status()).toBe(200)
  const llms = await page.request.get("/llms.txt")
  expect(llms.status()).toBe(200)
  const llmsBody = await llms.text()

  // The sitemap index advertises absolute production URLs. Fetch each child
  // from the LOCAL preview under test by taking only its pathname, the same way
  // scripts/crawl-built-site.mjs does — fetching the absolute URL would hit the
  // deployed site instead of the build being verified.
  const indexBody = await sitemap.text()
  const children = [...indexBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1], baseURL).pathname
  )
  expect(children.length, "the sitemap index should advertise its children").toBeGreaterThan(0)
  let urls = ""
  for (const child of children) {
    const res = await page.request.get(child)
    if (res.status() === 200) urls += await res.text()
  }

  const compareSlugs = readdirSync(new URL("../src/content/compare/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
  for (const slug of compareSlugs) {
    const retired = `/blog/${slug}-vs-lyrashield`
    expect(urls.includes(retired), `${retired} must not appear in the sitemap`).toBe(false)
    expect(llmsBody.includes(retired), `${retired} must not appear in llms.txt`).toBe(false)
    // The compare page it folded into must still be advertised.
    expect(urls.includes(`/compare/${slug}`), `/compare/${slug} must remain in the sitemap`).toBe(
      true
    )
  }
})

test("/index.html requests redirect 301 to the page route", async ({ page }) => {
  for (const path of ["/pricing/index.html", "/blog/index.html"]) {
    const res = await page.request.get(path, { maxRedirects: 0 })
    expect(res.status(), `${path} must be 301`).toBe(301)
    expect(res.headers()["location"]).toBe(path.replace(/\/index\.html$/, ""))
  }
})

test("the homepage itself never redirects", async ({ page }) => {
  const res = await page.request.get("/", { maxRedirects: 0 })
  expect(res.status()).toBe(200)
})

test("redirect responses carry permanent-redirect hygiene headers", async ({ page }) => {
  const res = await page.request.get("/pricing/", { maxRedirects: 0 })
  expect(res.status()).toBe(301)
  expect(res.headers()["cache-control"]).toBe("public, max-age=31536000")
  expect(res.headers()["x-robots-tag"]).toBe("noindex")
})

test("git-derived dateModified is present on the freshness pages", async ({ page }) => {
  const pagesToCheck: Array<[string, string]> = [
    ["/", "WebPage"],
    ["/agents", "WebPage"],
    ["/methodology", "WebPage"],
    ["/terms", "WebPage"],
  ]
  for (const [path, type] of pagesToCheck) {
    await page.goto(path)
    const dateModified = await page.evaluate((schemaType) => {
      const graphs = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      for (const el of graphs) {
        try {
          const parsed = JSON.parse(el.textContent ?? "null")
          const nodes = Array.isArray(parsed) ? parsed : [parsed]
          for (const node of nodes) {
            if (node?.["@type"] === schemaType && typeof node.dateModified === "string") {
              return node.dateModified
            }
          }
        } catch {
          // a non-JSON ld+json block is not ours to fail on
        }
      }
      return null
    }, type)
    expect(dateModified, `${path} must carry a git-derived dateModified`).not.toBeNull()
    expect(String(dateModified)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  }
})

test("the homepage sitemap entry carries lastmod", async ({ request }) => {
  const res = await request.get("/sitemap-0.xml")
  expect(res.status()).toBe(200)
  const body = await res.text()
  expect(body).toContain("<lastmod>")
  // The sitemap lists the bare homepage URL (https://host) as an entry; the
  // serialize normalization fix means it must carry lastmod like every other
  // URL. Find its exact <url> block.
  const firstEntry = body.split("</url>")[0] ?? ""
  const rootHasLastmod = /<url><loc>https?:\/[^<]+<\/loc><lastmod>[^<]+<\/lastmod>/.test(firstEntry)
  expect(rootHasLastmod, "the first sitemap entry (the homepage) must carry lastmod").toBe(true)
})
