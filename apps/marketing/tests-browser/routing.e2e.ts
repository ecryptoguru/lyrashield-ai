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

test("renders the comparison body with real typography and a themed prose colour", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/compare/snyk")

  const body = page.locator(".compare-body")
  await expect(body).toHaveClass(/prose/)

  // Headings, list markers and links must be styled, not plain 16px text.
  const h3 = body.locator("h3").first()
  await expect(h3).toBeVisible()
  expect(
    await h3.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  ).toBeGreaterThan(16)
  const firstLink = body.locator("a").first()
  expect(await firstLink.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain(
    "underline"
  )

  // The prose colour must follow the site theme, not the operating system.
  // Tailwind's `dark:` sits inside prefers-color-scheme, so a dark OS with the
  // site set to light used to leave headings pure white on a light page.
  await page.emulateMedia({ colorScheme: "dark" })
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
  const headingOnLight = await h3.evaluate((el) => getComputedStyle(el).color)
  expect(headingOnLight, "heading colour under a dark OS with the light theme").not.toBe(
    "rgb(255, 255, 255)"
  )

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
  const headingOnDark = await h3.evaluate((el) => getComputedStyle(el).color)
  expect(headingOnDark, "heading colour under the dark theme").not.toBe(headingOnLight)
})

// The swallowed-space bug is invisible in source review and survives both
// `astro check` and a build: the compiler drops the newline between two
// children, so `reach us through the` + `<a>support page</a>` renders as
// "through thesupport page". A source scan catches the shapes we know about,
// but it missed the one-line variant once. This asserts the rendered DOM, so
// the class of bug fails here regardless of how it is written.
test("joins text and inline elements with a space in the rendered DOM", async ({ page }) => {
  // Walk the text nodes of the main content and look for a word butting
  // straight into the next element's text, or an element's text butting into a
  // following word, with no whitespace between them.
  const adjacency = async (path: string) => {
    await page.goto(path)
    return page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body
      const problems: string[] = []
      // Elements whose text is inline prose and should never be flush against
      // a neighbouring word. Excludes decorative spans that carry their own
      // margin (a count-up marker, an arrow glyph).
      const INLINE = "a, code, strong, em, b, abbr"
      const wordish = /[A-Za-z0-9]$/
      const startsWordish = /^[A-Za-z0-9]/
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT)
      let node: Element | null = walker.currentNode as Element
      while (node) {
        for (const el of node.querySelectorAll(INLINE)) {
          const prev = el.previousSibling
          const next = el.nextSibling
          const text = el.textContent ?? ""
          if (prev && prev.nodeType === Node.TEXT_NODE) {
            const before = prev.textContent ?? ""
            if (wordish.test(before) && startsWordish.test(text)) {
              problems.push(
                `${el.tagName.toLowerCase()} joined to preceding text: ...${before.slice(-30)}|${text.slice(0, 30)}...`
              )
            }
          }
          if (next && next.nodeType === Node.TEXT_NODE) {
            const after = next.textContent ?? ""
            if (wordish.test(text) && startsWordish.test(after)) {
              problems.push(
                `${el.tagName.toLowerCase()} joined to following text: ...${text.slice(-30)}|${after.slice(0, 30)}...`
              )
            }
          }
        }
        node = walker.nextNode() as Element | null
      }
      return problems
    })
  }

  for (const path of [
    "/terms",
    "/demo",
    "/docs/integrations/agent-plugins",
    "/docs/integrations/zed",
  ]) {
    expect(await adjacency(path), `${path} must not swallow a space`).toEqual([])
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
