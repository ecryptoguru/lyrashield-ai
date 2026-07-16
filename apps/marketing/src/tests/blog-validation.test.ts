import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  checkExternalLinks,
  classifySource,
  parseArticle,
  validateArticle,
  validateArticleText,
  validateImageLibrary,
  validateUsageCounts,
} from "../../scripts/blog-validation-lib.mjs"

const stableFrontmatter = {
  title: "A unique security title",
  description:
    "A sufficiently detailed and unique description of the security guidance in this article.",
  tags: ["vibe-coding-security", "verification"],
  draft: false,
  heroImage: "verification-01",
  faq: [
    { q: "Question one?", a: "Answer one." },
    { q: "Question two?", a: "Answer two." },
  ],
}

describe("blog validator", () => {
  it("rejects prohibited punctuation, placeholders, and product claims", () => {
    const errors = validateArticleText(
      "Automatic fixes guarantee security — for every app. TODO: remove this."
    )

    expect(errors).toContain("prohibited em dash")
    expect(errors).toContain("prohibited product claim: guarantee security")
    expect(errors).toContain("prohibited product claim: automatic fixes")
    expect(errors).toContain("unresolved placeholder: TODO")
  })

  it("enforces the final shared-image distribution", () => {
    expect(validateUsageCounts([...Array(29).fill(3), ...Array(6).fill(2)], true)).toEqual([])
    expect(validateUsageCounts([...Array(35).fill(3)], true)).toContain(
      "shared image distribution must be 29x3 and 6x2"
    )
    expect(validateUsageCounts([4], false)).toContain("shared image usage must not exceed 3")
  })

  it("parses the supported article frontmatter and body", () => {
    const article = parseArticle(`---
title: "Parsed title"
description: "A long description that is deliberately valid for the article schema and validator."
tags: ["verification", "web-security"]
draft: false
heroImage: verification-01
faq:
  - q: "First question?"
    a: "First answer."
  - q: "Second question?"
    a: "Second answer."
---

First paragraph.

## Safe verification
`)

    expect(article.data).toMatchObject({
      title: "Parsed title",
      tags: ["verification", "web-security"],
      draft: false,
      heroImage: "verification-01",
    })
    expect(article.data.faq).toHaveLength(2)
    expect(article.body).toContain("## Safe verification")
  })

  it("validates article structure, links, sources, and release dependencies", () => {
    const directAnswer = Array(45).fill("answer").join(" ")
    const filler = Array(1160).fill("guidance").join(" ")
    const article = {
      slug: "supporting-article",
      data: stableFrontmatter,
      body: `${directAnswer}

## Verify safely

[Authority guide](/blog/vibe-coding-security-guide)

### Check the boundary

${filler}

[Free tool](/tools/security-headers) and [related article](/blog/related-article).

[OWASP](https://owasp.org/www-project-top-ten/) [NIST](https://csrc.nist.gov/publications) [RFC](https://www.rfc-editor.org/rfc/rfc9110)
`,
    }

    expect(
      validateArticle(
        article,
        { index: 2, slug: article.slug },
        {
          availableSlugs: new Set(["vibe-coding-security-guide", "related-article"]),
          titles: new Map([[stableFrontmatter.title, [article.slug]]]),
          descriptions: new Map([[stableFrontmatter.description, [article.slug]]]),
        }
      )
    ).toEqual([])

    const errors = validateArticle(
      {
        ...article,
        data: {
          ...stableFrontmatter,
          draft: true,
          tags: ["made-up-tag"],
          faq: [{ q: "Only question?", a: "Only answer." }],
        },
        body: article.body
          .replace("## Verify safely", "# Duplicate page title")
          .replace("/blog/related-article", "/blog/editorial-policy"),
      },
      { index: 2, slug: article.slug },
      {
        availableSlugs: new Set(["vibe-coding-security-guide"]),
        titles: new Map([[stableFrontmatter.title, [article.slug, "duplicate"]]]),
        descriptions: new Map([[stableFrontmatter.description, [article.slug, "duplicate"]]]),
      }
    )

    expect(errors).toContain("article body must not contain an H1")
    expect(errors).toContain("release article must set draft: false")
    expect(errors).toContain("invalid or unstable tag: made-up-tag")
    expect(errors).toContain("FAQ count must be between 2 and 4")
    expect(errors).toContain("duplicate article title")
    expect(errors).toContain("duplicate article description")
    expect(errors).toContain("missing related-article link")
    expect(errors).not.toContain("unpublished internal dependency: editorial-policy")
  })

  it("classifies primary and authoritative sources deterministically", () => {
    expect(classifySource("https://datatracker.ietf.org/doc/html/rfc9110")).toBe("primary")
    expect(classifySource("https://owasp.org/www-project-top-ten/")).toBe("official")
    expect(
      classifySource("https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/")
    ).toBe("official")
    expect(classifySource("https://arxiv.org/abs/2401.00001")).toBe("primary")
    expect(classifySource("https://example.net/opinion")).toBe("other")
    expect(classifySource("http://owasp.org/insecure")).toBe("invalid")
  })

  it("validates catalog paths, dimensions, budgets, hashes, clusters, and adjacency", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-validation-"))
    const imageRoot = join(root, "public/images/blog/library/verification-01")
    mkdirSync(imageRoot, { recursive: true })

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x06, 0x40, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ])
    for (const file of ["hero.avif", "hero.webp", "hero.jpg", "og.jpg", "social-portrait.jpg"]) {
      writeFileSync(join(imageRoot, file), jpeg)
    }

    const catalog = {
      "verification-01": {
        cluster: "verification",
        avif: "/images/blog/library/verification-01/hero.avif",
        webp: "/images/blog/library/verification-01/hero.webp",
        jpeg: "/images/blog/library/verification-01/hero.jpg",
        og: "/images/blog/library/verification-01/og.jpg",
        socialPortrait: "/images/blog/library/verification-01/social-portrait.jpg",
        alt: "A verification receipt crossing a controlled evidence boundary",
        width: 1600,
        height: 900,
      },
    }
    const manifests = [
      {
        release: "batch-1",
        entries: [
          {
            slug: "one",
            imageId: "verification-01",
            cluster: "verification",
            sourceHash: "a".repeat(64),
            usageCount: 2,
            approved: false,
          },
          {
            slug: "two",
            imageId: "verification-01",
            cluster: "verification",
            sourceHash: "a".repeat(64),
            usageCount: 2,
            approved: false,
          },
        ],
      },
    ]

    const errors = validateImageLibrary(catalog, manifests, root)
    expect(errors).toContain("batch-1: adjacent articles reuse image verification-01")
    expect(errors).toContain("verification-01 hero.avif must be an AVIF image")
    expect(errors).toContain("verification-01 hero.webp must be a WebP image")
    expect(errors).toContain("verification-01 og.jpg dimensions must be 1200x630")
    expect(errors).toContain("one: image approval is required")

    const badHash = structuredClone(manifests)
    badHash[0].entries[0].sourceHash = "pending"
    expect(validateImageLibrary(catalog, badHash, root)).toContain(
      "one: sourceHash must be a SHA-256 hex digest"
    )
  })

  it("checks HTTPS links once, falls back to a ranged GET, and redacts queries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 206 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))

    const errors = await checkExternalLinks(
      [
        {
          slug: "one",
          urls: [
            "https://docs.example.org/source?token=secret",
            "https://docs.example.org/source?token=secret",
            "http://insecure.example.org/source?token=secret",
          ],
        },
        { slug: "two", urls: ["https://unavailable.example.org/path?key=hidden"] },
      ],
      { fetchImpl: fetchMock, timeoutMs: 50 }
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(errors).toContain(
      "one: external source must use HTTPS: http://insecure.example.org/source"
    )
    expect(errors).toContain(
      "two: external source returned 503: https://unavailable.example.org/path"
    )
    expect(errors.join("\n")).not.toContain("secret")
    expect(errors.join("\n")).not.toContain("hidden")
  })
})
