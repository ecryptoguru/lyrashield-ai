import { expect, test } from "@playwright/test"

// Routing and freshness regression coverage for the run_worker_first routing
// change (PR #591). Every canonical URL on this site is slash-less; the
// middleware 301s trailing-slash and /index.html requests before the asset
// layer. The platform's drop-trailing-slash 307 must never appear for
// these paths. Pages must continue to serve 200 with the security headers
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

test("/index.html requests redirect 301 to the page route", async ({ page }) => {
  for (const path of ["/pricing/index.html", "/blog/index.html"]) {
    const res = await page.request.get(path, { maxRedirects: 0 })
    // Canonical hygiene: the index.html form must never serve content directly.
    // 301 = middleware or asset-layer canonicalisation fired.
    expect([301, 308], `${path} must redirect, not serve`).toContain(res.status())
    if (res.status() === 301) {
      expect(res.headers()["location"]).toBe(path.replace(/\/index\.html$/, ""))
    }
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
