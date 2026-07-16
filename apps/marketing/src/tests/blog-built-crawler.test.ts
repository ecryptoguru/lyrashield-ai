import { describe, expect, it } from "vitest"
import {
  crawlBuiltBlog,
  extractSitemapLocations,
  inspectHtml,
  sanitizeReportUrl,
  validatePageFacts,
} from "../../scripts/crawl-built-blog.mjs"

const articleUrl = "http://localhost:8787/blog/example-post"

function articleHtml(overrides = ""): string {
  return `<!doctype html>
<html>
  <head>
    <title>Example security post</title>
    <meta name="description" content="A complete description for an example post.">
    <link rel="canonical" href="${articleUrl}">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting"}</script>
  </head>
  <body>
    <main>
      <h1>Example security post</h1>
      <h2 id="safe-check">Safe check</h2>
      <a href="#safe-check">Jump to the check</a>
      <a href="/blog/tags/verification">Verification</a>
      <img src="/images/blog/library/example/hero.jpg" alt="Abstract evidence gate">
      <a href="/blog/related-post">Related</a>
      ${overrides}
    </main>
  </body>
</html>`
}

function response(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  })
}

describe("built blog crawler helpers", () => {
  it("parses sitemap locations and strips query data from reports", () => {
    expect(
      extractSitemapLocations(`<?xml version="1.0"?><urlset>
        <url><loc>http://localhost:8787/blog/example-post?secret=1#part</loc></url>
      </urlset>`)
    ).toEqual(["http://localhost:8787/blog/example-post?secret=1#part"])
    expect(sanitizeReportUrl("http://localhost:8787/blog/example-post?secret=1#part")).toBe(
      "http://localhost:8787/blog/example-post"
    )
  })

  it("extracts metadata, structure, anchors, media, tags, and JSON-LD", () => {
    const facts = inspectHtml(articleHtml(), articleUrl)

    expect(facts).toMatchObject({
      title: "Example security post",
      description: "A complete description for an example post.",
      canonical: articleUrl,
      h1Count: 1,
      mainCount: 1,
      jsonLdCount: 1,
      jsonLdErrors: [],
      hasDraftMarker: false,
    })
    expect(facts.anchorErrors).toEqual([])
    expect(facts.imageUrls).toEqual(["http://localhost:8787/images/blog/library/example/hero.jpg"])
    expect(facts.tagUrls).toEqual(["http://localhost:8787/blog/tags/verification"])
  })

  it("finds structural, anchor, schema, and draft regressions", () => {
    const html = articleHtml(`
      <h1>Second title</h1>
      <a href="#missing">Broken jump</a>
      <span class="blog-post__draft">Draft</span>
      <script type="application/ld+json">{"broken"</script>
    `).replace("<main>", "<main><main>")
    const facts = inspectHtml(html, `${articleUrl}?target=private`)

    expect(facts.h1Count).toBe(2)
    expect(facts.mainCount).toBe(2)
    expect(facts.anchorErrors).toEqual(["missing anchor #missing"])
    expect(facts.jsonLdErrors).toHaveLength(1)
    expect(facts.hasDraftMarker).toBe(true)
  })

  it("requires parseable JSON-LD and an image on article pages", () => {
    const withoutJsonLd = articleHtml().replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      "<script>window.fixture = true</script>"
    )
    const facts = inspectHtml(withoutJsonLd.replace(/<img\b[^>]*>/, ""), articleUrl)

    expect(validatePageFacts(articleUrl, facts, { requireImage: true })).toEqual([
      `${articleUrl}: missing JSON-LD`,
      `${articleUrl}: article has no images`,
    ])
  })
})

describe("built blog crawler", () => {
  it("validates sitemap pages, RSS membership, tags, media, and query-free errors", async () => {
    const origin = "http://localhost:8787"
    const bodies = new Map<string, Response>([
      [
        `${origin}/sitemap-index.xml`,
        response(
          `<sitemapindex><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
          "application/xml"
        ),
      ],
      [
        `${origin}/sitemap-0.xml`,
        response(
          `<urlset><url><loc>${origin}/blog/example-post</loc></url><url><loc>${origin}/blog/tags/verification</loc></url></urlset>`,
          "application/xml"
        ),
      ],
      [articleUrl, response(articleHtml(), "text/html")],
      [
        `${origin}/blog/tags/verification`,
        response(
          `<!doctype html><html><head><title>Verification</title><meta name="description" content="Verification posts"><link rel="canonical" href="${origin}/blog/tags/verification"><script type="application/ld+json">{}</script></head><body><main><h1>Verification</h1><a href="/blog/example-post">Post</a></main></body></html>`,
          "text/html"
        ),
      ],
      [
        `${origin}/rss.xml`,
        response(
          `<rss><channel><item><link>${articleUrl}</link></item></channel></rss>`,
          "application/rss+xml"
        ),
      ],
      [`${origin}/images/blog/library/example/hero.jpg`, response("image", "image/jpeg")],
    ])
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const found = bodies.get(url)
      return found ? found.clone() : new Response("missing", { status: 404 })
    }

    await expect(
      crawlBuiltBlog({
        origin,
        fetchImpl,
        expectedArticleSlugs: ["example-post"],
      })
    ).resolves.toMatchObject({ articleCount: 1, tagCount: 1, errors: [] })

    bodies.set(articleUrl, response(articleHtml('<a href="#missing">Broken</a>'), "text/html"))
    const failed = await crawlBuiltBlog({
      origin: `${origin}?private=target`,
      fetchImpl,
      expectedArticleSlugs: ["example-post"],
    })
    expect(failed.errors.join("\n")).toContain(articleUrl)
    expect(failed.errors.join("\n")).not.toContain("private=target")
  })
})
