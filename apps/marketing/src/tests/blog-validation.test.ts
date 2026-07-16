import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"
import program from "../content/blog-program.json"

import {
  checkExternalLinks,
  classifySource,
  parseArticle,
  validateArticle,
  validateArticleText,
  validateImageLibrary,
  validateProgramRoot,
  validateUsageCounts,
} from "../../scripts/blog-validation-lib.mjs"

function createFixtureDirectory(path: string) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test paths are descendants of mkdtemp-created fixture roots.
  mkdirSync(path, { recursive: true })
}

function writeFixtureFile(path: string, contents: string | Uint8Array) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test paths are descendants of mkdtemp-created fixture roots.
  writeFileSync(path, contents)
}

const scripts = [
  "validate-blog-content.mjs",
  "validate-blog-images.mjs",
  "check-external-blog-links.mjs",
].map((file) => fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url)))

function avif(width: number, height: number, size = 40) {
  const buffer = Buffer.alloc(size)
  buffer.write("ftyp", 4, "ascii")
  buffer.write("avif", 8, "ascii")
  buffer.write("ispe", 16, "ascii")
  buffer.writeUInt32BE(width, 24)
  buffer.writeUInt32BE(height, 28)
  return buffer
}

function webp(width: number, height: number, size = 30) {
  const buffer = Buffer.alloc(size)
  buffer.write("RIFF", 0, "ascii")
  buffer.writeUInt32LE(22, 4)
  buffer.write("WEBP", 8, "ascii")
  buffer.write("VP8X", 12, "ascii")
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

function jpeg(width: number, height: number, size = 23) {
  const buffer = Buffer.alloc(size)
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]).copy(buffer)
  return buffer
}

function catalogEntry(imageId: string, cluster = "verification") {
  return {
    cluster,
    avif: `/images/blog/library/${imageId}/hero.avif`,
    webp: `/images/blog/library/${imageId}/hero.webp`,
    jpeg: `/images/blog/library/${imageId}/hero.jpg`,
    og: `/images/blog/library/${imageId}/og.jpg`,
    socialPortrait: `/images/blog/library/${imageId}/social-portrait.jpg`,
    alt: `A deterministic evidence concept for ${imageId}`,
    width: 1600,
    height: 900,
  }
}

function writeImageSet(root: string, imageId: string, avifSize = 40) {
  const imageRoot = join(root, "public/images/blog/library", imageId)
  createFixtureDirectory(imageRoot)
  writeFixtureFile(join(imageRoot, "hero.avif"), avif(1600, 900, avifSize))
  writeFixtureFile(join(imageRoot, "hero.webp"), webp(1600, 900))
  writeFixtureFile(join(imageRoot, "hero.jpg"), jpeg(1600, 900))
  writeFixtureFile(join(imageRoot, "og.jpg"), jpeg(1200, 630))
  writeFixtureFile(join(imageRoot, "social-portrait.jpg"), jpeg(1080, 1350))
  return imageRoot
}

function manifestEntry(
  slug: string,
  imageId: string,
  usageCount: number,
  cluster = "verification"
) {
  return {
    slug,
    imageId,
    cluster,
    sourceHash: `sha256:${"a".repeat(64)}`,
    usageCount,
    approved: true,
  }
}

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
    expect((article.data as { faq?: unknown[] }).faq).toHaveLength(2)
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

[RLS checker](/tools/supabase-rls-checker) and [related article](/blog/related-article).

[OWASP](https://owasp.org/www-project-top-ten/) [NIST](https://csrc.nist.gov/publications) [RFC](https://www.rfc-editor.org/rfc/rfc9110)
`,
    }

    expect(
      validateArticle(
        article,
        { index: 2, slug: article.slug, cluster: "Access", cta: "Pillar + RLS Checker" },
        {
          availableSlugs: new Set(["vibe-coding-security-guide", "related-article"]),
          programBySlug: new Map([
            [article.slug, { index: 2, slug: article.slug, cluster: "Access" }],
            ["related-article", { index: 3, slug: "related-article", cluster: "Access" }],
          ]),
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
      { index: 2, slug: article.slug, cluster: "Access", cta: "Pillar + RLS Checker" },
      {
        availableSlugs: new Set(["vibe-coding-security-guide"]),
        programBySlug: new Map([
          [article.slug, { index: 2, slug: article.slug, cluster: "Access" }],
        ]),
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
    expect(errors).toContain("missing mapped topically related article link")
    expect(errors).not.toContain("unpublished internal dependency: editorial-policy")
  })

  it("requires the approved CTA route and a mapped topically related article", () => {
    const directAnswer = Array(45).fill("answer").join(" ")
    const filler = Array(1160).fill("guidance").join(" ")
    const base = {
      slug: "supporting-article",
      data: stableFrontmatter,
      body: `${directAnswer}

## Verify safely

[Authority guide](/blog/vibe-coding-security-guide)

${filler}

[Wrong tool](/tools/security-headers-checker) and [unrelated post](/blog/payment-post).

[OWASP](https://owasp.org/a) [NIST](https://csrc.nist.gov/b) [RFC](https://www.rfc-editor.org/c)
`,
    }
    const programBySlug = new Map<
      string,
      { index: number; slug: string; cluster: string; cta?: string }
    >([
      [base.slug, { index: 2, slug: base.slug, cluster: "Access" }],
      ["payment-post", { index: 24, slug: "payment-post", cluster: "Payments" }],
    ])
    const errors = validateArticle(
      base,
      { index: 2, slug: base.slug, cluster: "Access", cta: "Pillar + RLS Checker" },
      {
        availableSlugs: new Set(["vibe-coding-security-guide", "payment-post"]),
        programBySlug,
      }
    )

    expect(errors).toContain(
      "missing approved CTA link for Pillar + RLS Checker: /tools/supabase-rls-checker"
    )
    expect(errors).toContain("missing mapped topically related article link")

    const corrected = {
      ...base,
      body: base.body
        .replace("/tools/security-headers-checker", "/tools/supabase-rls-checker")
        .replace("/blog/payment-post", "/blog/access-post"),
    }
    programBySlug.set("access-post", { index: 3, slug: "access-post", cluster: "Access" })
    expect(
      validateArticle(
        corrected,
        { index: 2, slug: base.slug, cluster: "Access", cta: "Pillar + RLS Checker" },
        {
          availableSlugs: new Set(["vibe-coding-security-guide", "access-post"]),
          programBySlug,
        }
      )
    ).toEqual([])
  })

  it("counts query and fragment variants of one external resource only once", () => {
    const directAnswer = Array(45).fill("answer").join(" ")
    const filler = Array(1160).fill("guidance").join(" ")
    const entry = {
      index: 2,
      slug: "source-count-article",
      cluster: "Access",
      cta: "Pillar + RLS Checker",
    }
    const article = {
      slug: entry.slug,
      data: stableFrontmatter,
      body: `${directAnswer}

## Verify safely

[Authority guide](/blog/vibe-coding-security-guide)

${filler}

[RLS checker](/tools/supabase-rls-checker) and [related article](/blog/access-post).

[First view](https://owasp.org/reference?view=1) [Second view](https://owasp.org/reference?view=2) [Fragment](https://owasp.org/reference#third)
`,
    }
    const errors = validateArticle(article, entry, {
      availableSlugs: new Set(["vibe-coding-security-guide", "access-post"]),
      programBySlug: new Map<
        string,
        { index: number; slug: string; cluster: string; cta?: string }
      >([
        [entry.slug, entry],
        ["access-post", { index: 3, slug: "access-post", cluster: "Access" }],
      ]),
    })

    expect(errors).toContain("article requires at least 3 external sources")
    expect(errors).toContain("article requires at least 2 primary or official sources")
  })

  it("rejects FTP and scheme-relative external source links", () => {
    const directAnswer = Array(45).fill("answer").join(" ")
    const filler = Array(1160).fill("guidance").join(" ")
    const entry = {
      index: 2,
      slug: "https-only-article",
      cluster: "Access",
      cta: "Pillar + RLS Checker",
    }
    const article = {
      slug: entry.slug,
      data: stableFrontmatter,
      body: `${directAnswer}

## Verify safely

[Authority guide](/blog/vibe-coding-security-guide)

${filler}

[RLS checker](/tools/supabase-rls-checker) and [related article](/blog/access-post).

[OWASP](https://owasp.org/a) [NIST](https://nist.gov/b) [RFC](https://www.rfc-editor.org/c)
[FTP source](ftp://insecure.example.org/source?token=secret)
[Scheme-relative source](//insecure.example.org/relative?token=secret)
`,
    }
    const errors = validateArticle(article, entry, {
      availableSlugs: new Set(["vibe-coding-security-guide", "access-post"]),
      programBySlug: new Map<
        string,
        { index: number; slug: string; cluster: string; cta?: string }
      >([
        [entry.slug, entry],
        ["access-post", { index: 3, slug: "access-post", cluster: "Access" }],
      ]),
    })

    expect(errors).toContain("external source must use HTTPS: ftp://insecure.example.org/source")
    expect(errors).toContain("external source must use HTTPS: //insecure.example.org/relative")
    expect(errors.join("\n")).not.toContain("secret")
  })

  it.each([
    ["GitHub diff", "Pillar + GitHub diff gate"],
    ["MCP", "Pillar + MCP security"],
  ])("keeps %s topic CTAs on the honest free checklist", (_topic, cta) => {
    const directAnswer = Array(45).fill("answer").join(" ")
    const filler = Array(1160).fill("guidance").join(" ")
    const entry = { index: 28, slug: "workflow-post", cluster: "Agent", cta }
    const programBySlug = new Map<
      string,
      { index: number; slug: string; cluster: string; cta?: string }
    >([
      [entry.slug, entry],
      ["agent-post", { index: 29, slug: "agent-post", cluster: "Agent" }],
    ])
    const article = {
      slug: entry.slug,
      data: stableFrontmatter,
      body: `${directAnswer}

## Verify safely

[Authority guide](/blog/vibe-coding-security-guide)

${filler}

[Free checklist](/tools/ai-app-security-checklist) and [related article](/blog/agent-post).

[OWASP](https://owasp.org/a) [NIST](https://csrc.nist.gov/b) [RFC](https://www.rfc-editor.org/c)
`,
    }
    const context = {
      availableSlugs: new Set(["vibe-coding-security-guide", "agent-post"]),
      programBySlug,
    }

    expect(validateArticle(article, entry, context)).toEqual([])

    const scanOnly = {
      ...article,
      body: article.body.replace("/tools/ai-app-security-checklist", "/scan"),
    }
    expect(validateArticle(scanOnly, entry, context)).toContain(
      `missing approved CTA link for ${cta}: /tools/ai-app-security-checklist`
    )
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
    createFixtureDirectory(imageRoot)

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x06, 0x40, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ])
    for (const file of ["hero.avif", "hero.webp", "hero.jpg", "og.jpg", "social-portrait.jpg"]) {
      writeFixtureFile(join(imageRoot, file), jpeg)
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
            sourceHash: `sha256:${"a".repeat(64)}`,
            usageCount: 2,
            approved: false,
          },
          {
            slug: "two",
            imageId: "verification-01",
            cluster: "verification",
            sourceHash: `sha256:${"a".repeat(64)}`,
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
      "one: sourceHash must be sha256:<64 lowercase hex>"
    )
    badHash[0].entries[0].sourceHash = `sha256:${"A".repeat(64)}`
    expect(validateImageLibrary(catalog, badHash, root)).toContain(
      "one: sourceHash must be sha256:<64 lowercase hex>"
    )
  })

  it("accepts valid five-format images exactly at the byte budget and rejects one byte over", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-validation-boundary-"))
    const imageId = "authority-guide-01"
    const imageRoot = writeImageSet(root, imageId, 220_000)
    const boundaryFiles = [
      { file: "hero.avif", max: 220_000, build: (size: number) => avif(1600, 900, size) },
      { file: "hero.webp", max: 320_000, build: (size: number) => webp(1600, 900, size) },
      { file: "hero.jpg", max: 320_000, build: (size: number) => jpeg(1600, 900, size) },
      { file: "og.jpg", max: 350_000, build: (size: number) => jpeg(1200, 630, size) },
      {
        file: "social-portrait.jpg",
        max: 350_000,
        build: (size: number) => jpeg(1080, 1350, size),
      },
    ]
    for (const boundary of boundaryFiles) {
      writeFixtureFile(join(imageRoot, boundary.file), boundary.build(boundary.max))
    }
    const catalog = { [imageId]: catalogEntry(imageId, "authority") }
    const manifests = [
      { release: "authority", entries: [manifestEntry("authority", imageId, 1, "authority")] },
    ]

    expect(validateImageLibrary(catalog, manifests, root)).toEqual([])
    for (const boundary of boundaryFiles) {
      writeFixtureFile(join(imageRoot, boundary.file), boundary.build(boundary.max + 1))
      expect(validateImageLibrary(catalog, manifests, root)).toContain(
        `${imageId} ${boundary.file} exceeds ${boundary.max} bytes`
      )
      writeFixtureFile(join(imageRoot, boundary.file), boundary.build(boundary.max))
    }
  })

  it("accepts the complete authority plus 29x3 and 6x2 image library", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-validation-final-"))
    const catalog: Record<string, ReturnType<typeof catalogEntry>> = {}
    const authorityId = "authority-guide-01"
    catalog[authorityId] = catalogEntry(authorityId, "authority")
    writeImageSet(root, authorityId)

    const sharedIds = [...Array(35)].map((_, index) => `verification-${index + 1}`)
    const tripleIds = new Set(sharedIds.slice(0, 29))
    for (const imageId of sharedIds) {
      catalog[imageId] = catalogEntry(imageId)
      writeImageSet(root, imageId)
    }
    const assignments = [
      ...sharedIds,
      ...sharedIds,
      ...sharedIds.filter((imageId) => tripleIds.has(imageId)),
    ]
    const counts = new Map(sharedIds.map((imageId) => [imageId, tripleIds.has(imageId) ? 3 : 2]))
    const manifests = [
      {
        release: "authority",
        entries: [manifestEntry("authority", authorityId, 1, "authority")],
      },
      {
        release: "batch-1",
        entries: assignments.map((imageId, index) =>
          manifestEntry(`article-${index + 1}`, imageId, counts.get(imageId)!)
        ),
      },
    ]

    expect(validateImageLibrary(catalog, manifests, root, { finalDistribution: true })).toEqual([])
  })

  it("requires exactly one authority image and 36 images across 100 final assignments", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-validation-cardinality-"))
    const catalog: Record<string, ReturnType<typeof catalogEntry>> = {}
    const authorityIds = ["authority-guide-01", "authority-guide-02"]
    for (const imageId of authorityIds) {
      catalog[imageId] = catalogEntry(imageId, "authority")
      writeImageSet(root, imageId)
    }

    const sharedIds = [...Array(35)].map((_, index) => `verification-${index + 1}`)
    const tripleIds = new Set(sharedIds.slice(0, 29))
    for (const imageId of sharedIds) {
      catalog[imageId] = catalogEntry(imageId)
      writeImageSet(root, imageId)
    }
    const assignments = [
      ...sharedIds,
      ...sharedIds,
      ...sharedIds.filter((imageId) => tripleIds.has(imageId)),
    ]
    const counts = new Map(sharedIds.map((imageId) => [imageId, tripleIds.has(imageId) ? 3 : 2]))
    const manifests = [
      {
        release: "authority",
        entries: authorityIds.map((imageId, index) =>
          manifestEntry(`authority-${index + 1}`, imageId, 1, "authority")
        ),
      },
      {
        release: "batch-1",
        entries: assignments.map((imageId, index) =>
          manifestEntry(`article-${index + 1}`, imageId, counts.get(imageId)!)
        ),
      },
    ]

    const errors = validateImageLibrary(catalog, manifests, root, { finalDistribution: true })
    expect(errors).toContain(
      "final image distribution must contain exactly 1 authority image; found 2"
    )
    expect(errors).toContain("final image distribution must contain exactly 36 images; found 37")
    expect(errors).toContain(
      "final image distribution must contain exactly 100 assignments; found 101"
    )
  })

  it("rejects malformed manifest roots, orphan catalog entries, and unexpected library files", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-validation-shape-"))
    const imageId = "verification-01"
    const imageRoot = writeImageSet(root, imageId)
    writeFixtureFile(join(imageRoot, "unexpected.txt"), "unexpected")
    createFixtureDirectory(join(root, "public/images/blog/library/orphan-directory"))
    const catalog = {
      [imageId]: catalogEntry(imageId),
      "orphan-catalog": catalogEntry("orphan-catalog"),
    }
    const manifests = [
      { release: "batch-1", entries: [manifestEntry("one", imageId, 1)] },
      { release: "authority", entries: { images: [] } },
    ]
    const errors = validateImageLibrary(catalog, manifests, root)

    expect(errors).toContain("authority: image manifest must be a top-level array")
    expect(errors).toContain("orphan image catalog entry: orphan-catalog")
    expect(errors).toContain(`${imageId}: unexpected image library file unexpected.txt`)
    expect(errors).toContain("unexpected image library directory: orphan-directory")
  })

  it("rejects malformed program roots and missing --release values deterministically", () => {
    expect(validateProgramRoot(program)).toEqual([])
    expect(validateProgramRoot({ entries: [] })).toEqual(["blog program must be a top-level array"])
    expect(validateProgramRoot([{ slug: "", batch: "authority" }])).toContain(
      "blog program entry 1 has an invalid slug"
    )

    for (const script of scripts) {
      const result = spawnSync(process.execPath, [script, "--release"], { encoding: "utf8" })
      expect(result.status, script).toBe(1)
      expect(result.stderr, script).toContain("--release requires a value")
    }
  })

  it("checks HTTPS links once, falls back to a ranged GET, and redacts queries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 206 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
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

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
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

  it("uses one ranged GET to disambiguate every unsuccessful HEAD response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))

    const errors = await checkExternalLinks(
      [
        { slug: "head-404", urls: ["https://www.rfc-editor.org/source?token=secret"] },
        { slug: "still-down", urls: ["https://nist.gov/source?key=hidden"] },
        { slug: "protected", urls: ["https://help.openai.com/source?session=private"] },
        { slug: "auth-required", urls: ["https://doi.org/source?credential=private"] },
      ],
      { fetchImpl: fetchMock, timeoutMs: 50 }
    )

    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(fetchMock.mock.calls[7]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    })
    expect(errors).not.toContain(
      "head-404: external source returned 404: https://www.rfc-editor.org/source"
    )
    expect(errors).toContain("still-down: external source returned 502: https://nist.gov/source")
    expect(errors).not.toContain(
      "protected: external source returned 403: https://help.openai.com/source"
    )
    expect(errors).not.toContain(
      "auth-required: external source returned 401: https://doi.org/source"
    )
    expect(errors.join("\n")).not.toContain("secret")
    expect(errors.join("\n")).not.toContain("hidden")
    expect(errors.join("\n")).not.toContain("private")
  })
})
