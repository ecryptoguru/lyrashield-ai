import { readFileSync } from "node:fs"
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import type { CollectionEntry } from "astro:content"
import { describe, expect, it } from "vitest"
import { markdownWordCount as validatorWordCount } from "../../scripts/blog-validation-lib.mjs"
import BlogPost from "../layouts/BlogPost.astro"
import { markdownWordCount, readingMinutes } from "../lib/blog-content"

function source(relativePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
}

describe("blog editorial trust rendering", () => {
  it("uses the same Markdown-aware prose count as release validation", () => {
    const markdown = `## A heading

Count [linked words](/target), but not Markdown syntax.

\`inline code still reads as prose\`.

\`\`\`ts
const ignored = "fenced code"
\`\`\``

    expect(markdownWordCount(markdown)).toBe(validatorWordCount(markdown))
    expect(readingMinutes(markdown)).toBe(1)
  })

  it("renders exact article, Organization, and catalog image metadata", async () => {
    // Astro 7.0.7's container ignores its documented astroConfig.site option,
    // so site-derived URLs use this deterministic default while canonical stays explicit.
    const container = await AstroContainer.create()
    const author = {
      id: "lyrashield-team",
      collection: "authors",
      data: {
        name: "LyraShield Team",
        kind: "Organization",
        role: "Security + Engineering",
        profileUrl: "/blog/editorial-policy",
        bio: "Maintains evidence-state guidance for AI-built apps.",
      },
    } satisfies CollectionEntry<"authors">
    const heroImage = {
      id: "authority-guide-01",
      collection: "blogImages",
      data: {
        cluster: "authority",
        avif: "/images/blog/library/authority-guide-01/hero.avif",
        webp: "/images/blog/library/authority-guide-01/hero.webp",
        jpeg: "/images/blog/library/authority-guide-01/hero.jpg",
        og: "/images/blog/library/authority-guide-01/og.jpg",
        socialPortrait: "/images/blog/library/authority-guide-01/social-portrait.jpg",
        alt: "Six security layers joining at a translucent evidence gate",
        width: 1600,
        height: 900,
      },
    } satisfies CollectionEntry<"blogImages">
    const html = await container.renderToString(BlogPost, {
      request: new Request("https://lyrashieldai.com/blog/synthetic-security-guide"),
      partial: false,
      props: {
        title: "Synthetic security guide",
        description:
          "A deterministic rendered fixture for article metadata, authorship, and catalog media.",
        pubDate: new Date("2026-07-17T00:00:00.000Z"),
        updatedDate: new Date("2026-07-18T00:00:00.000Z"),
        author,
        tags: ["verification"],
        draft: false,
        canonical: "https://lyrashieldai.com/blog/synthetic-security-guide",
        headings: [{ depth: 2, slug: "evidence", text: "Evidence" }],
        readingMinutes: 6,
        relatedPosts: [],
        wordCount: 1234,
        heroImage,
      },
      slots: { default: '<h2 id="evidence">Evidence</h2><p>Rendered article body.</p>' },
    })

    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain(
      '<link rel="canonical" href="https://lyrashieldai.com/blog/synthetic-security-guide">'
    )
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(html).toContain(
      '<meta property="og:image" content="http://localhost:4321/images/blog/library/authority-guide-01/og.jpg">'
    )
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain(
      '<meta property="og:image:alt" content="Six security layers joining at a translucent evidence gate">'
    )
    expect(html).toContain(
      '<meta name="twitter:image" content="http://localhost:4321/images/blog/library/authority-guide-01/og.jpg">'
    )
    expect(html).toContain(
      '<meta property="article:published_time" content="2026-07-17T00:00:00.000Z">'
    )
    expect(html).toContain(
      '<meta property="article:modified_time" content="2026-07-18T00:00:00.000Z">'
    )
    expect(html).toContain('href="/blog/editorial-policy"')
    expect(html).toContain('srcset="/images/blog/library/authority-guide-01/hero.avif"')
    expect(html).toContain('srcset="/images/blog/library/authority-guide-01/hero.webp"')
    expect(html).toContain('src="/images/blog/library/authority-guide-01/hero.jpg"')
    expect(html).toContain('width="1600"')
    expect(html).toContain('height="900"')
    expect(html).toContain('loading="eager"')
    expect(html).toContain('fetchpriority="high"')
    expect(html).toContain('sizes="(min-width: 1024px) 784px, calc(100vw - 2rem)"')

    const jsonLdSource = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    )?.[1]
    expect(jsonLdSource).toBeDefined()
    const jsonLd = JSON.parse(jsonLdSource ?? "[]") as Array<Record<string, unknown>>
    const article = jsonLd.find((entry) => entry["@type"] === "BlogPosting") as {
      author: Record<string, unknown>
      image: Record<string, unknown>
      mainEntityOfPage: Record<string, unknown>
      publisher: Record<string, unknown>
      wordCount: number
    }

    expect(article.author).toMatchObject({
      "@type": "Organization",
      name: "LyraShield Team",
      description: "Maintains evidence-state guidance for AI-built apps.",
      url: "http://localhost:4321/blog/editorial-policy",
      parentOrganization: { "@id": "http://localhost:4321/#organization" },
    })
    expect(article.image).toEqual({
      "@type": "ImageObject",
      url: "http://localhost:4321/images/blog/library/authority-guide-01/og.jpg",
      width: 1200,
      height: 630,
      caption: "Six security layers joining at a translucent evidence gate",
    })
    expect(article.mainEntityOfPage).toEqual({
      "@type": "WebPage",
      "@id": "https://lyrashieldai.com/blog/synthetic-security-guide",
    })
    expect(article.publisher).toEqual({ "@id": "http://localhost:4321/#organization" })
    expect(article.wordCount).toBe(1234)
  })

  it("renders referenced images lazily on archive cards", () => {
    const card = source("../components/BlogCard.astro")

    expect(card).toContain("getEntry(post.data.heroImage)")
    expect(card).toContain("<picture")
    expect(card).toContain('type="image/avif"')
    expect(card).toContain('type="image/webp"')
    expect(card).toContain('loading="lazy"')
    expect(card).toContain('width="1600"')
    expect(card).toContain('height="900"')
  })

  it("keeps the editorial policy indexable and outside the article collection", () => {
    const policy = source("../pages/blog/editorial-policy.astro")
    expect(policy).toContain("How LyraShield AI publishes security guidance")
    expect(policy).not.toContain("noindex={true}")
    expect(policy).toContain("AI assistance")
    expect(policy).toContain("Human accountability")
    expect(policy).toContain("Primary sources")
    expect(policy).toContain("Corrections and material updates")
    expect(policy).toContain("Image review")
  })

  it("keeps drafts out of every discovery surface", () => {
    const index = source("../pages/blog/[...page].astro")
    const tags = source("../pages/blog/tags/[tag].astro")
    const llms = source("../pages/llms.txt.ts")

    for (const surface of [index, tags, llms]) {
      expect(surface).toContain("!entry.data.draft")
      expect(surface).not.toContain("import.meta.env.DEV || !entry.data.draft")
    }
    expect(llms).toContain("`${origin}/blog/editorial-policy`")
  })
})
