# LyraShield AI authority blog program implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, review, and publish the approved 100-article LyraShield AI security library with 36 optimized source artworks, a transparent editorial policy, deterministic content validation, and complete SEO, GEO, accessibility, and release verification.

**Architecture:** Keep Astro content collections as the only publishing system. Add a typed image catalog and a machine-readable article program manifest, then validate every article against those contracts before Astro builds. Produce one authority release and six sequential batches; each batch remains private until every article, image, source map, internal link, rendered page, and release gate passes.

**Tech Stack:** Astro 7 content collections and MDX, TypeScript, Vitest, Node.js validation scripts, Sharp 0.34.5 for deterministic image derivatives, Codex Imagegen for 36 source artworks, Cloudflare Workers through the existing guarded marketing workflow.

## Global constraints

- Publish exactly 100 indexable articles from the topic and slug map in `docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md`; the editorial policy is separate and does not count.
- Publish in this order: authority topic 1, topics 2 to 18, topics 19 to 35, topics 36 to 52, topics 53 to 68, topics 69 to 84, and topics 85 to 100.
- Use `LyraShield Team` as an Organization author. Do not invent a person, credentials, customers, incidents, benchmarks, pricing, or first-hand experience.
- Run every article through the Humanizer draft, remaining-pattern audit, and final rewrite loop. Final article prose contains no em dash or en dash characters.
- The authority guide contains 2,500 to 3,000 words and at least eight primary or authoritative references.
- Each supporting article contains 1,200 to 1,500 words and at least three authoritative references, including at least two primary or official sources.
- Every supporting article contains a 40 to 80 word direct answer, a concrete vulnerable symptom or pattern, why generated code misses it, safe verification, a corrected pattern with edge cases, automation limits, an authority-guide link in the first third, one relevant free-tool link, one related-article link, visible dates, and two to four FAQs only when they add distinct answers.
- Keep detected, independently verified, retest-confirmed, and inconclusive states separate. Never claim universal verification, automatic fix-PR execution, a security guarantee, customers, pricing, or performance benchmarks.
- Use only these tags: `vibe-coding-security`, `access-control`, `web-security`, `supply-chain`, `agent-security`, and `verification`; a post may use no more than five.
- Use exactly 36 text-free Codex Imagegen source artworks: one exclusive authority image plus 35 shared supporting images. Of the shared set, 29 images serve three posts and 6 images serve two posts. No image serves more than three posts.
- Source artwork is square at 2048 by 2048 or larger. Derivatives are 1600 by 900 AVIF, WebP, and JPEG; 1200 by 630 Open Graph JPEG; and 1080 by 1350 portrait JPEG.
- File budgets are at most 220 KB for AVIF hero, 320 KB for WebP hero, 320 KB for JPEG hero, and 350 KB for each social JPEG.
- Keep image masters ignored under `apps/marketing-motion/renders/blog-masters/`. Commit only optimized files under `apps/marketing/public/images/blog/library/`.
- Add no CMS, React runtime, client-side filtering library, or new content framework.
- Do not provision or modify Cloudflare resources, R2, or DNS. Production publication uses the existing guarded marketing workflow only after the corresponding local batch and human approval gates pass.
- Preserve all unrelated uncommitted work. Stage only the files named by the active task.

---

### Task 1: Add machine-readable program and image contracts

**Files:**

- Create: `apps/marketing/src/content/blog-program.json`
- Create: `apps/marketing/src/content/blog-images/images.json`
- Modify: `apps/marketing/src/content.config.ts`
- Modify: `apps/marketing/src/content/authors/authors.json`
- Create: `apps/marketing/src/tests/blog-contracts.test.ts`

**Interfaces:**

- Consumes: the exact 100 rows from `docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md` and the image entry shape from the approved design spec.
- Produces: `blogProgram` entries with `index`, `title`, `slug`, `query`, `cluster`, `targetWords`, `batch`, and `cta`; a `blogImages` content collection; `heroImage: reference("blogImages")`; and author field `kind: "Organization" | "Person"`.

- [ ] **Step 1: Write the failing contract tests**

```ts
import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import images from "../content/blog-images/images.json"
import authors from "../content/authors/authors.json"

describe("blog program contracts", () => {
  it("contains the exact ordered 100-topic program", () => {
    expect(program).toHaveLength(100)
    expect(program[0]).toMatchObject({
      index: 1,
      slug: "vibe-coding-security-guide",
      batch: "authority",
    })
    expect(program[99]).toMatchObject({
      index: 100,
      slug: "exposed-api-key-incident-response",
      batch: "batch-6",
    })
    expect(new Set(program.map((entry) => entry.slug)).size).toBe(100)
  })

  it("starts with an empty typed image catalog", () => {
    expect(images).toEqual({})
  })

  it("declares LyraShield Team as an organization", () => {
    expect(authors["lyrashield-team"].kind).toBe("Organization")
  })
})
```

- [ ] **Step 2: Run the test and verify the missing files fail collection**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-contracts.test.ts`

Expected: FAIL because `blog-program.json`, `blog-images/images.json`, and the author `kind` field do not exist.

- [ ] **Step 3: Add the exact manifest and schemas**

Transcribe all 100 rows from the approved topic table without shortening titles, slugs, queries, clusters, target word counts, or CTA descriptions. Assign `authority` to topic 1, `batch-1` to topics 2 to 18, `batch-2` to 19 to 35, `batch-3` to 36 to 52, `batch-4` to 53 to 68, `batch-5` to 69 to 84, and `batch-6` to 85 to 100.

```ts
const blogImages = defineCollection({
  loader: file("src/content/blog-images/images.json"),
  schema: z.object({
    cluster: z.enum([
      "authority",
      "access-control",
      "web-execution",
      "supply-chain",
      "agent-security",
      "verification",
      "decision-operations",
    ]),
    avif: z.string().startsWith("/images/blog/library/"),
    webp: z.string().startsWith("/images/blog/library/"),
    jpeg: z.string().startsWith("/images/blog/library/"),
    og: z.string().startsWith("/images/blog/library/"),
    socialPortrait: z.string().startsWith("/images/blog/library/"),
    alt: z.string().min(20).max(180),
    width: z.literal(1600),
    height: z.literal(900),
  }),
})

const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string().max(70),
    description: z.string().min(70).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: reference("authors"),
    tags: z
      .array(
        z.enum([
          "vibe-coding-security",
          "access-control",
          "web-security",
          "supply-chain",
          "agent-security",
          "verification",
        ])
      )
      .min(1)
      .max(5),
    draft: z.boolean().default(true),
    heroImage: reference("blogImages"),
    canonical: z.url().optional(),
    faq: z
      .array(z.object({ q: z.string(), a: z.string() }))
      .min(2)
      .max(4)
      .optional(),
  }),
})

const authors = defineCollection({
  loader: file("src/content/authors/authors.json"),
  schema: z.object({
    name: z.string(),
    kind: z.enum(["Organization", "Person"]),
    role: z.string(),
    xUrl: z.url().optional(),
    profileUrl: z.string().startsWith("/").optional(),
    bio: z.string(),
  }),
})

export const collections = { blog, authors, blogImages }
```

Set `lyrashield-team.kind` to `Organization` and `lyrashield-team.profileUrl` to `/blog/editorial-policy`.

- [ ] **Step 4: Run the focused tests and Astro typecheck**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-contracts.test.ts && pnpm --filter @lyrashield/marketing typecheck`

Expected: PASS with 100 unique program entries and valid content schemas.

- [ ] **Step 5: Commit only the contract files**

```bash
git add apps/marketing/src/content/blog-program.json apps/marketing/src/content/blog-images/images.json apps/marketing/src/content.config.ts apps/marketing/src/content/authors/authors.json apps/marketing/src/tests/blog-contracts.test.ts
git commit -m "feat(marketing): add authority blog contracts"
```

### Task 2: Build deterministic article and image validation

**Files:**

- Create: `apps/marketing/scripts/blog-validation-lib.mjs`
- Create: `apps/marketing/scripts/validate-blog-content.mjs`
- Create: `apps/marketing/scripts/validate-blog-images.mjs`
- Create: `apps/marketing/scripts/check-external-blog-links.mjs`
- Create: `apps/marketing/src/tests/blog-validation.test.ts`
- Modify: `apps/marketing/package.json`

**Interfaces:**

- Consumes: `blog-program.json`, `blog-images/images.json`, the seven release image manifests, and article Markdown or MDX.
- Produces: `validateArticle(article, programEntry, context)`, `validateImageLibrary(catalog, manifests, root)`, CLI scripts `blog:validate`, `blog:validate:images`, and `blog:check-links`, plus nonzero exits on violations.

- [ ] **Step 1: Write failing tests for the non-negotiable checks**

```ts
import { describe, expect, it } from "vitest"
import { validateArticleText, validateUsageCounts } from "../../scripts/blog-validation-lib.mjs"

describe("blog validator", () => {
  it("rejects prohibited punctuation and product claims", () => {
    const errors = validateArticleText("Automatic fixes guarantee security — for every app.")
    expect(errors).toContain("prohibited em dash")
    expect(errors).toContain("prohibited product claim: guarantee security")
    expect(errors).toContain("prohibited product claim: automatic fixes")
  })

  it("enforces the final shared-image distribution", () => {
    expect(validateUsageCounts([...Array(29).fill(3), ...Array(6).fill(2)], true)).toEqual([])
    expect(validateUsageCounts([...Array(35).fill(3)], true)).toContain(
      "shared image distribution must be 29x3 and 6x2"
    )
  })
})
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-validation.test.ts`

Expected: FAIL because `blog-validation-lib.mjs` does not exist.

- [ ] **Step 3: Implement deterministic validators**

Implement pure functions for UTF-8 punctuation checks, prohibited-claim patterns, stable tags, unresolved placeholders, title and description uniqueness, heading hierarchy, word counts, direct-answer word counts, authority-link position, relevant tool and related links, FAQ counts, source classification, unpublished internal dependencies, image catalog paths, dimensions, byte budgets, SHA-256 source hashes, cluster matches, adjacency reuse, per-image usage, and final 29-by-3 plus 6-by-2 distribution.

Use these prohibited placeholders: `TBD`, `TODO`, `TK`, `lorem ipsum`, `example.com`, `[citation needed]`, and empty Markdown links. Use these prohibited claim stems case-insensitively: `guarantee security`, `fully secure`, `automatically fix`, `automatic PR`, `all 50`, `zero false positives`, `100% accurate`, `customers include`, and `starting at $`.

The link checker accepts only HTTPS external sources, sends `HEAD` with a 10 second timeout, retries once with `GET` and a one-byte range when `HEAD` is unsupported, caches results by URL for the run, and reports source URL plus article slug without logging query strings.

Add scripts:

```json
{
  "blog:validate": "node scripts/validate-blog-content.mjs",
  "blog:validate:images": "node scripts/validate-blog-images.mjs",
  "blog:check-links": "node scripts/check-external-blog-links.mjs"
}
```

- [ ] **Step 4: Run validator tests and verify the current sample drafts fail intentionally**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-validation.test.ts && pnpm --filter @lyrashield/marketing blog:validate -- --release authority`

Expected: tests PASS; the release CLI exits nonzero because the authority article and its image manifest do not exist yet.

- [ ] **Step 5: Commit the validation foundation**

```bash
git add apps/marketing/scripts/blog-validation-lib.mjs apps/marketing/scripts/validate-blog-content.mjs apps/marketing/scripts/validate-blog-images.mjs apps/marketing/scripts/check-external-blog-links.mjs apps/marketing/src/tests/blog-validation.test.ts apps/marketing/package.json pnpm-lock.yaml
git commit -m "feat(marketing): validate blog release quality"
```

### Task 3: Build the 36-image derivation pipeline

**Files:**

- Create: `apps/marketing-motion/scripts/derive-blog-images.mjs`
- Create: `apps/marketing-motion/scripts/verify-blog-images.mjs`
- Create: `apps/marketing-motion/scripts/blog-image-lib.mjs`
- Create: `apps/marketing-motion/tests/blog-image-lib.test.mjs`
- Modify: `apps/marketing-motion/package.json`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: `apps/marketing-motion/renders/blog-masters/<image-id>/source.png` and the seven `docs/editorial/blog-image-manifests/*.json` files.
- Produces: deterministic hero and social derivatives under `apps/marketing/public/images/blog/library/<image-id>/`, catalog entries, byte-budget reports, and source SHA-256 values.

- [ ] **Step 1: Write failing crop and path tests**

```js
import assert from "node:assert/strict"
import test from "node:test"
import { outputPaths, validateSourceDimensions } from "../scripts/blog-image-lib.mjs"

test("builds all five output paths", () => {
  assert.deepEqual(Object.keys(outputPaths("access-boundary-01")), [
    "avif",
    "webp",
    "jpeg",
    "og",
    "socialPortrait",
  ])
})

test("requires a square source at least 2048 pixels", () => {
  assert.deepEqual(validateSourceDimensions({ width: 2048, height: 2048 }), [])
  assert.match(validateSourceDimensions({ width: 1600, height: 900 })[0], /square/)
})
```

- [ ] **Step 2: Run the image test and verify the module is missing**

Run: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs`

Expected: FAIL because `blog-image-lib.mjs` does not exist.

- [ ] **Step 3: Add Sharp and deterministic image scripts**

Declare `sharp: "0.34.5"` in `apps/marketing-motion` devDependencies. Derive crops with focal point `centre`, `fit: "cover"`, no enlargement, stripped metadata, and these initial settings: AVIF quality 58 effort 7, WebP quality 76 effort 6, JPEG quality 80 progressive with 4:2:0 chroma subsampling. The script must fail if a derivative exceeds its budget; it may lower quality in two-point increments down to AVIF 46, WebP 66, or JPEG 70 before failing.

Add scripts:

```json
{
  "blog:images:derive": "node scripts/derive-blog-images.mjs",
  "blog:images:verify": "node scripts/verify-blog-images.mjs"
}
```

Add these ignore rules without changing existing rules:

```gitignore
apps/marketing-motion/renders/blog-masters/
apps/marketing-motion/renders/blog-image-previews/
```

- [ ] **Step 4: Run unit tests and verify the empty catalog cleanly reports no work**

Run: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs && pnpm --filter @lyrashield/marketing-motion blog:images:verify -- --allow-empty`

Expected: PASS; verification reports zero catalog images because creation begins in Task 5.

- [ ] **Step 5: Commit the image pipeline**

```bash
git add apps/marketing-motion/scripts/derive-blog-images.mjs apps/marketing-motion/scripts/verify-blog-images.mjs apps/marketing-motion/scripts/blog-image-lib.mjs apps/marketing-motion/tests/blog-image-lib.test.mjs apps/marketing-motion/package.json .gitignore pnpm-lock.yaml
git commit -m "feat(marketing): add blog image pipeline"
```

### Task 4: Render organizational authorship, editorial policy, and catalog images

**Files:**

- Create: `apps/marketing/src/pages/blog/editorial-policy.astro`
- Modify: `apps/marketing/src/pages/blog/[slug].astro`
- Modify: `apps/marketing/src/layouts/BlogPost.astro`
- Modify: `apps/marketing/src/components/BlogCard.astro`
- Modify: `apps/marketing/src/components/SeoHead.astro`
- Modify: `apps/marketing/src/pages/blog/[...page].astro`
- Modify: `apps/marketing/src/pages/blog/tags/[tag].astro`
- Modify: `apps/marketing/src/pages/llms.txt.ts`
- Modify: `apps/marketing/src/tests/seo.test.ts`
- Create: `apps/marketing/src/tests/blog-rendering.test.ts`

**Interfaces:**

- Consumes: `heroImage` references and author `kind/profileUrl` from Task 1.
- Produces: responsive `<picture>` markup, catalog Open Graph image selection, Organization author JSON-LD, editorial-policy trust page, visible policy link, and draft-safe discovery surfaces.

- [ ] **Step 1: Add failing rendering and schema tests**

```ts
it("emits Organization authorship and the referenced social image", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/blog/vibe-coding-security-guide"),
    env,
    ctx
  )
  const html = await response.text()
  expect(html).toContain('"@type":"Organization"')
  expect(html).toContain("/images/blog/library/authority-guide-01/og.jpg")
  expect(html).toContain('href="/blog/editorial-policy"')
})

it("keeps the editorial policy indexable and outside article counts", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/blog/editorial-policy"),
    env,
    ctx
  )
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(html).toContain("How LyraShield AI publishes security guidance")
  expect(html).not.toContain('name="robots" content="noindex')
})
```

- [ ] **Step 2: Run tests and verify the policy route and Organization schema fail**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/seo.test.ts src/tests/blog-rendering.test.ts`

Expected: FAIL because the policy route is absent and article JSON-LD still uses `Person`.

- [ ] **Step 3: Implement visible and structured article trust signals**

Resolve the `blogImages` reference in `[slug].astro` and pass the entry to `BlogPost`. Render AVIF, WebP, and JPEG sources with explicit 1600 by 900 dimensions, descriptive alt text, `loading="eager"` and `fetchpriority="high"` on article pages, and responsive `sizes`. Use the catalog `og` path for Open Graph, Twitter, and `BlogPosting.image`.

Emit the author `@type` from `author.data.kind`. Organization authorship includes `name`, `description`, `url`, and publisher relationship; Person-only fields such as `jobTitle` remain conditional. Link the author block to `profileUrl`.

The editorial policy must visibly explain AI assistance, human accountability, primary-source standards, safe examples, limitations of automated checks, corrections, visible material-update notes, stable URLs, stable anchors, and image review. Do not describe draft workflow internals as proof of article correctness.

Archive cards use `loading="lazy"`, explicit dimensions, and the referenced AVIF/WebP/JPEG set. Draft posts remain absent from archives, sitemap, RSS, tags, and `llms.txt`.

- [ ] **Step 4: Run focused tests, typecheck, and build**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/seo.test.ts src/tests/blog-rendering.test.ts && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS with an indexable policy route and valid image and author metadata.

- [ ] **Step 5: Commit the rendering layer**

```bash
git add apps/marketing/src/pages/blog/editorial-policy.astro apps/marketing/src/pages/blog/[slug].astro apps/marketing/src/layouts/BlogPost.astro apps/marketing/src/components/BlogCard.astro apps/marketing/src/components/SeoHead.astro apps/marketing/src/pages/blog/[...page].astro apps/marketing/src/pages/blog/tags/[tag].astro apps/marketing/src/pages/llms.txt.ts apps/marketing/src/tests/seo.test.ts apps/marketing/src/tests/blog-rendering.test.ts
git commit -m "feat(marketing): add blog editorial trust layer"
```

### Task 5: Produce the authority release and all 36 approved image concepts

**Files:**

- Create: `docs/editorial/blog-briefs/authority.md`
- Create: `docs/editorial/blog-research/authority.md`
- Create: `docs/editorial/blog-image-manifests/authority.json`
- Create: `docs/editorial/blog-image-manifests/batch-1.json`
- Create: `docs/editorial/blog-image-manifests/batch-2.json`
- Create: `docs/editorial/blog-image-manifests/batch-3.json`
- Create: `docs/editorial/blog-image-manifests/batch-4.json`
- Create: `docs/editorial/blog-image-manifests/batch-5.json`
- Create: `docs/editorial/blog-image-manifests/batch-6.json`
- Create: `apps/marketing/src/content/blog/vibe-coding-security-guide.mdx`
- Delete: `apps/marketing/src/content/blog/ai-built-security.md`
- Delete: `apps/marketing/src/content/blog/verified-findings.mdx`
- Modify: `apps/marketing/src/content/blog-images/images.json`
- Create: `apps/marketing/public/images/blog/library/authority-guide-01/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/access-boundary-{01,02,03,04,05,06}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/web-execution-{01,02,03,04,05,06}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/supply-chain-{01,02,03,04,05}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/agent-security-{01,02,03,04,05,06}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/verification-{01,02,03,04,05,06}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`
- Create: `apps/marketing/public/images/blog/library/decision-operations-{01,02,03,04,05,06}/{hero.avif,hero.webp,hero.jpg,og.jpg,social-portrait.jpg}`

**Interfaces:**

- Consumes: topic 1 contract, 100-topic manifest, primary research, Codex Imagegen, and the image pipeline.
- Produces: the 2,500 to 3,000 word authority guide, a reviewed 36-image assignment system, one exclusive authority artwork, and all optimized derivatives required by later batches.

- [ ] **Step 1: Write the authority brief and the complete image assignment manifests**

The brief fixes query `vibe coding security`, reader problem, six security layers, competing LyraShield URLs, at least eight required primary or authoritative sources, internal links, CTA, FAQ decision, and the exclusive authority image concept. Each image manifest entry uses:

```json
{
  "slug": "vibe-coding-security-guide",
  "imageId": "authority-guide-01",
  "cluster": "authority",
  "concept": "A controlled evidence path joining six security layers before a release gate",
  "prompt": "Text-free square cinematic technical artwork, matte graphite security layers converging through translucent evidence planes into a controlled release gate, navy atmosphere, restrained cyan green amber and red signals, protected central subject, sparse haze, no people, no logos, no dashboards, no words, no letters, no numbers",
  "alt": "Six layered security paths joining at a translucent evidence gate",
  "sourceHash": null,
  "cropNotes": "Keep the convergence point inside the central 60 percent safe area",
  "usageCount": 1,
  "approved": false
}
```

Assign exactly six access-control, six web-execution, five supply-chain, six agent-security, six verification, and six decision-operations supporting images. Map 29 supporting image IDs to three articles and six to two articles, with no adjacent same-image assignments in any release.

- [ ] **Step 2: Research the authority guide from primary sources**

Use live official sources for OWASP Top 10 and ASVS, MITRE CWE, NIST SSDF, NCSC secure development guidance, OAuth and web RFCs where relevant, official platform documentation, and original research cited in the approved SEO plan. Record each material claim, source URL, source owner, publication or update date, and exact article section in `docs/editorial/blog-research/authority.md`. Reject claims that cannot be tied to an authoritative source.

- [ ] **Step 3: Generate and approve 36 source artworks**

Generate one source at a time with Codex Imagegen from the exact manifest prompt. Inspect each full-resolution source for text fragments, pseudo-logos, people, fake interfaces, unsafe implications, artifacts, central crop safety, and cluster fit. Regenerate failed sources. Save approved sources as `apps/marketing-motion/renders/blog-masters/{imageId}/source.png`. The derivation script replaces the initial `null` hash with `sha256:<64 lowercase hexadecimal characters>` before `approved` can become `true`; validation rejects an approved entry with a null or malformed hash.

- [ ] **Step 4: Derive all variants and verify budgets and distribution**

Run: `pnpm --filter @lyrashield/marketing-motion blog:images:derive && pnpm --filter @lyrashield/marketing-motion blog:images:verify && pnpm --filter @lyrashield/marketing blog:validate:images -- --final-distribution`

Expected: PASS with 36 catalog entries, 180 optimized files, all dimensions and budgets valid, one authority-only image, and the shared 29-by-3 plus 6-by-2 distribution.

- [ ] **Step 5: Draft, audit, and finalize the authority article**

Draft 2,500 to 3,000 words around the six security layers. Include the direct definition near the top, safe examples, the Target to Assurance Report evidence loop, the 43 machine-testable and 7 evidence-required Vibe Security 50 split, limitations, relevant tools, and links that will become valid in Batch 1. Run the Humanizer process explicitly: preserve a draft, write a brief remaining-pattern audit in the research file, then rewrite the public MDX. Scan final prose for em dash, en dash, vague attributions, formulaic signposting, repeated three-part cadence, promotional claims, and manufactured conclusions.

- [ ] **Step 6: Remove placeholder posts and run the authority release gate**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release authority && pnpm --filter @lyrashield/marketing blog:validate:images -- --release authority && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build && git diff --check`

Expected: PASS with one mapped article, no sample posts, valid authority links or explicitly declared future dependencies that remain non-clickable until their batch publishes, and no prohibited prose patterns.

- [ ] **Step 7: Complete local browser review and record approval**

Test `/blog/vibe-coding-security-guide` and `/blog/editorial-policy` in the Worker-backed localhost build at 390 pixels, tablet, and desktop; light and dark themes; no JavaScript; keyboard navigation; 200 percent zoom; and screen-reader reading order. Confirm one H1, one main landmark, no horizontal overflow, no console errors, image crops, visible source dates, structured data, canonical, sitemap, RSS, and `llms.txt` behavior. Record human approval in both authority manifests before marking the release publishable.

- [ ] **Step 8: Commit the authority release assets and content**

```bash
git add docs/editorial/blog-briefs/authority.md docs/editorial/blog-research/authority.md docs/editorial/blog-image-manifests apps/marketing/src/content/blog apps/marketing/src/content/blog-images/images.json apps/marketing/public/images/blog/library
git commit -m "feat(marketing): publish vibe coding security guide"
```

### Task 6: Produce Batch 1, topics 2 to 18

**Files:**

- Create: `docs/editorial/blog-briefs/batch-1.md`
- Create: `docs/editorial/blog-research/batch-1.md`
- Modify: `docs/editorial/blog-image-manifests/batch-1.json`
- Create: `apps/marketing/src/content/blog/supabase-rls-vibe-coded-apps.mdx`
- Create: `apps/marketing/src/content/blog/idor-ai-built-apps.mdx`
- Create: `apps/marketing/src/content/blog/api-keys-frontend-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/client-side-auth-not-security.mdx`
- Create: `apps/marketing/src/content/blog/server-side-authorization-ai-apis.mdx`
- Create: `apps/marketing/src/content/blog/multi-tenant-data-isolation.mdx`
- Create: `apps/marketing/src/content/blog/secure-admin-routes.mdx`
- Create: `apps/marketing/src/content/blog/jwt-validation-mistakes.mdx`
- Create: `apps/marketing/src/content/blog/password-reset-email-verification-security.mdx`
- Create: `apps/marketing/src/content/blog/password-hashing-vibe-coders.mdx`
- Create: `apps/marketing/src/content/blog/sql-injection-ai-generated-code.mdx`
- Create: `apps/marketing/src/content/blog/xss-ai-app-markdown-output.mdx`
- Create: `apps/marketing/src/content/blog/input-validation-ai-generated-api.mdx`
- Create: `apps/marketing/src/content/blog/cors-vibe-coded-apps.mdx`
- Create: `apps/marketing/src/content/blog/csrf-cookie-auth-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/ssrf-protection-dns-redirects.mdx`
- Create: `apps/marketing/src/content/blog/secure-file-uploads-ai-apps.mdx`

**Interfaces:**

- Consumes: program entries 2 to 18, authority guide, image assignments, stable tags, and article contract.
- Produces: 17 reviewed articles on Supabase RLS, IDOR, frontend keys, client and server authorization, tenant isolation, admin routes, JWTs, password recovery and hashing, SQL injection, XSS, input validation, CORS, CSRF, SSRF, and file uploads.

- [ ] **Step 1: Write and approve 17 cannibalization-safe briefs**

For each program entry, record the exact primary query, one-sentence reader problem, unique angle, required entities, competing LyraShield URL check, at least three authoritative sources with two primary or official sources, exact authority link, relevant tool CTA, one related article dependency, FAQ decision, and assigned image ID.

- [ ] **Step 2: Research every material technical claim**

Use current OWASP, MITRE CWE, RFC, browser, Supabase, authentication-library, and vendor documentation as applicable. Record claim-to-source mappings and source dates. Do not use community posts as proof of prevalence, correctness, or product performance.

- [ ] **Step 3: Draft all 17 articles from their approved briefs**

Each draft must satisfy the supporting-article contract and remain between 1,200 and 1,500 words. Label vulnerable code, avoid deployable exploit instructions, test corrected examples for syntax where practical, and state what the verification steps cannot prove.

- [ ] **Step 4: Run the Humanizer and technical review gates article by article**

For each article, preserve meaning, audit remaining AI tells, rewrite the final MDX, scan for prohibited punctuation and claims, verify citations, and record security-truth, product-claim, image, and individual publication approvals in the batch research and image manifest.

- [ ] **Step 5: Run the Batch 1 validation and browser gate**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-1 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-1 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-1 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for all 17 articles, their authority and related links, source links, image assignments, schema, sitemap, RSS, tag archives, and `llms.txt` entries.

Test representative access-control, authentication, input, and web articles at 390 pixels and desktop in the Worker preview. Run Lighthouse on one content-heavy article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 6: Commit the approved Batch 1 release candidate**

```bash
git add docs/editorial/blog-briefs/batch-1.md docs/editorial/blog-research/batch-1.md docs/editorial/blog-image-manifests/batch-1.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch one"
```

### Task 7: Produce Batch 2, topics 19 to 35

**Files:**

- Create: `docs/editorial/blog-briefs/batch-2.md`
- Create: `docs/editorial/blog-research/batch-2.md`
- Modify: `docs/editorial/blog-image-manifests/batch-2.json`
- Create: `apps/marketing/src/content/blog/path-traversal-generated-code.mdx`
- Create: `apps/marketing/src/content/blog/command-injection-agentic-apps.mdx`
- Create: `apps/marketing/src/content/blog/oauth-redirect-callback-security.mdx`
- Create: `apps/marketing/src/content/blog/rate-limiting-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/brute-force-account-enumeration.mdx`
- Create: `apps/marketing/src/content/blog/stripe-webhook-signature-security.mdx`
- Create: `apps/marketing/src/content/blog/payment-entitlement-server-source-truth.mdx`
- Create: `apps/marketing/src/content/blog/mass-assignment-crud-api.mdx`
- Create: `apps/marketing/src/content/blog/idempotency-replay-protection.mdx`
- Create: `apps/marketing/src/content/blog/security-headers-ai-built-apps.mdx`
- Create: `apps/marketing/src/content/blog/secure-session-cookie-settings.mdx`
- Create: `apps/marketing/src/content/blog/tls-mobile-transport-security.mdx`
- Create: `apps/marketing/src/content/blog/public-by-default-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/debug-routes-error-leaks.mdx`
- Create: `apps/marketing/src/content/blog/source-map-build-artifact-security.mdx`
- Create: `apps/marketing/src/content/blog/sensitive-data-logging.mdx`
- Create: `apps/marketing/src/content/blog/security-audit-log-design.mdx`

**Interfaces:**

- Consumes: program entries 19 to 35 and all Task 6 contracts.
- Produces: 17 reviewed articles on path traversal, command injection, OAuth, rate limiting, enumeration, Stripe webhooks, entitlements, mass assignment, idempotency, security headers, cookies, transport security, public exposure, debug leakage, source maps, sensitive logs, and audit logs.

- [ ] **Step 1: Complete briefs, cannibalization review, and claim maps**

For each program entry, record the exact primary query, one-sentence reader problem, unique angle, required entities, competing LyraShield URL check, at least three authoritative sources including two primary or official sources, exact authority link, relevant tool CTA, one related article dependency, FAQ decision, and assigned image ID. Separate overlapping intents such as rate limits versus brute force, Stripe signature validation versus entitlement truth, and verbose errors versus source-map exposure.

- [ ] **Step 2: Draft 17 contract-complete articles**

Keep every article between 1,200 and 1,500 words. Use safe local examples, exact official behavior, clearly labeled vulnerable patterns, corrected patterns with edge cases, automation limits, contextual links, and distinct FAQs only where needed.

- [ ] **Step 3: Apply Humanizer, technical truth, product claim, and individual approval gates**

Record the remaining-pattern audit and corrections in `docs/editorial/blog-research/batch-2.md`. Final public prose contains no em dash or en dash, fake expertise, vague expert attribution, generic conclusion, or unsupported prevalence claim.

- [ ] **Step 4: Validate and render the full batch**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-2 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-2 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-2 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for all 17 articles. Browser-test representative execution, payment, exposure, and audit articles, plus archive pagination and tag pages. Run Lighthouse on one representative article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 5: Commit Batch 2**

```bash
git add docs/editorial/blog-briefs/batch-2.md docs/editorial/blog-research/batch-2.md docs/editorial/blog-image-manifests/batch-2.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch two"
```

### Task 8: Produce Batch 3, topics 36 to 52

**Files:**

- Create: `docs/editorial/blog-briefs/batch-3.md`
- Create: `docs/editorial/blog-research/batch-3.md`
- Modify: `docs/editorial/blog-image-manifests/batch-3.json`
- Create: `apps/marketing/src/content/blog/security-monitoring-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/backup-restore-agentic-apps.mdx`
- Create: `apps/marketing/src/content/blog/ai-dependency-vulnerability-audit.mdx`
- Create: `apps/marketing/src/content/blog/hallucinated-packages-slopsquatting.mdx`
- Create: `apps/marketing/src/content/blog/install-script-supply-chain-security.mdx`
- Create: `apps/marketing/src/content/blog/secrets-ai-coding-prompts.mdx`
- Create: `apps/marketing/src/content/blog/indirect-prompt-injection-coding-agents.mdx`
- Create: `apps/marketing/src/content/blog/least-privilege-mcp-tools.mdx`
- Create: `apps/marketing/src/content/blog/coding-agent-sandbox-egress.mdx`
- Create: `apps/marketing/src/content/blog/agent-production-permissions.mdx`
- Create: `apps/marketing/src/content/blog/agent-rules-file-security.mdx`
- Create: `apps/marketing/src/content/blog/ai-generated-tests-security.mdx`
- Create: `apps/marketing/src/content/blog/cicd-agent-confused-deputy.mdx`
- Create: `apps/marketing/src/content/blog/multi-agent-prompt-injection.mdx`
- Create: `apps/marketing/src/content/blog/placeholder-logic-silent-failures.mdx`
- Create: `apps/marketing/src/content/blog/human-review-threat-model-vibe-coding.mdx`
- Create: `apps/marketing/src/content/blog/cursor-app-security-checklist.mdx`

**Interfaces:**

- Consumes: program entries 36 to 52 and the existing published-link graph.
- Produces: 17 reviewed articles on monitoring, restore proof, dependency risk, slopsquatting, install scripts, prompt privacy and injection, MCP permissions, sandboxes, production permissions, rules files, generated tests, CI agents, multi-agent propagation, placeholder logic, human review, and Cursor workflows.

- [ ] **Step 1: Complete briefs and current primary research**

Use official OWASP, NIST, GitHub, package-registry, model-provider, MCP, CI/CD, and tool documentation plus original research where appropriate. Separate demonstrated behavior from inferred risk, and date any fast-changing vendor behavior.

- [ ] **Step 2: Draft all 17 articles and test examples safely**

Meet the complete article contract. Do not turn prompt-injection or agent-permission examples into copy-paste exfiltration instructions. Keep product and vendor descriptions tied to currently verified official documentation.

- [ ] **Step 3: Apply Humanizer and individual approval gates**

Review each article for repeated openings, uniform structure, inflated AI-risk claims, unsupported generalization, and fake certainty. Preserve the technical register and explicit uncertainty where the evidence is incomplete.

- [ ] **Step 4: Run Batch 3 validation, build, browser, and Lighthouse gates**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-3 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-3 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-3 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for 17 articles and all discovery surfaces. Browser-test representative supply-chain, prompt-injection, sandbox, verification, and workflow articles. Run Lighthouse on one representative article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 5: Commit Batch 3**

```bash
git add docs/editorial/blog-briefs/batch-3.md docs/editorial/blog-research/batch-3.md docs/editorial/blog-image-manifests/batch-3.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch three"
```

### Task 9: Produce Batch 4, topics 53 to 68

**Files:**

- Create: `docs/editorial/blog-briefs/batch-4.md`
- Create: `docs/editorial/blog-research/batch-4.md`
- Modify: `docs/editorial/blog-image-manifests/batch-4.json`
- Create: `apps/marketing/src/content/blog/claude-code-security-workflow.mdx`
- Create: `apps/marketing/src/content/blog/codex-security-workflow.mdx`
- Create: `apps/marketing/src/content/blog/windsurf-security-workflow.mdx`
- Create: `apps/marketing/src/content/blog/lovable-app-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/bolt-app-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/replit-app-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/v0-app-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/base44-app-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/supabase-security-guide.mdx`
- Create: `apps/marketing/src/content/blog/firebase-security-guide.mdx`
- Create: `apps/marketing/src/content/blog/nextjs-ai-app-security.mdx`
- Create: `apps/marketing/src/content/blog/react-frontend-security-ai-code.mdx`
- Create: `apps/marketing/src/content/blog/node-express-ai-api-security.mdx`
- Create: `apps/marketing/src/content/blog/fastapi-ai-generated-security.mdx`
- Create: `apps/marketing/src/content/blog/vercel-deployment-security.mdx`
- Create: `apps/marketing/src/content/blog/cloudflare-workers-ai-security.mdx`

**Interfaces:**

- Consumes: program entries 53 to 68 and live official vendor documentation.
- Produces: 16 reviewed articles covering Claude Code, Codex, Windsurf, Lovable, Bolt, Replit, v0, Base44, Supabase, Firebase, Next.js, React, Node and Express, FastAPI, Vercel, and Cloudflare Workers.

- [ ] **Step 1: Complete intent-separated vendor and stack briefs**

Anchor each article in platform-specific trust boundaries and official security controls. Do not duplicate a generic checklist with renamed headings. Record the date and version context for behavior likely to change.

- [ ] **Step 2: Research and draft 16 articles**

Verify current claims against official documentation. Use framework-specific vulnerable and corrected patterns, note configuration and deployment edge cases, and separate platform features from application responsibilities.

- [ ] **Step 3: Apply Humanizer and approval gates**

Remove generic vendor praise, repetitive checklist rhythm, fake first-person experience, and claims that a platform control proves application security. For every article, record source verification, security-truth review, prohibited-product-claim review, image approval, and individual publication approval.

- [ ] **Step 4: Validate and render Batch 4**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-4 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-4 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-4 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for 16 articles. Browser-test at least one coding tool, app builder, frontend framework, API framework, and deployment article. Run Lighthouse on one representative article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 5: Commit Batch 4**

```bash
git add docs/editorial/blog-briefs/batch-4.md docs/editorial/blog-research/batch-4.md docs/editorial/blog-image-manifests/batch-4.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch four"
```

### Task 10: Produce Batch 5, topics 69 to 84

**Files:**

- Create: `docs/editorial/blog-briefs/batch-5.md`
- Create: `docs/editorial/blog-research/batch-5.md`
- Modify: `docs/editorial/blog-image-manifests/batch-5.json`
- Create: `apps/marketing/src/content/blog/github-actions-coding-agent-security.mdx`
- Create: `apps/marketing/src/content/blog/secure-mcp-server-guide.mdx`
- Create: `apps/marketing/src/content/blog/ai-saas-stripe-security.mdx`
- Create: `apps/marketing/src/content/blog/ai-app-prelaunch-security-checklist.mdx`
- Create: `apps/marketing/src/content/blog/two-account-idor-test.mdx`
- Create: `apps/marketing/src/content/blog/secret-scanning-before-commit.mdx`
- Create: `apps/marketing/src/content/blog/osv-dependency-scanning.mdx`
- Create: `apps/marketing/src/content/blog/sast-dast-sca-ai-apps.mdx`
- Create: `apps/marketing/src/content/blog/ai-security-review-prompt.mdx`
- Create: `apps/marketing/src/content/blog/threat-model-ai-startup.mdx`
- Create: `apps/marketing/src/content/blog/security-fix-retest-workflow.mdx`
- Create: `apps/marketing/src/content/blog/verify-security-finding.mdx`
- Create: `apps/marketing/src/content/blog/sarif-ai-coding-workflow.mdx`
- Create: `apps/marketing/src/content/blog/security-diff-gate-pull-requests.mdx`
- Create: `apps/marketing/src/content/blog/security-launch-readiness-gate.mdx`
- Create: `apps/marketing/src/content/blog/client-security-report-handoff.mdx`

**Interfaces:**

- Consumes: program entries 69 to 84 and the current LyraShield methodology and tool pages.
- Produces: 16 reviewed articles on GitHub Actions, MCP servers, Stripe SaaS, prelaunch checks, two-account testing, secret scanning, OSV, SAST/DAST/SCA, review prompts, threat models, retests, finding verification, SARIF, PR gates, launch readiness, and client reports.

- [ ] **Step 1: Complete briefs and claim-to-source research**

Separate comparison intent from product workflow intent. Tie LyraShield references only to currently implemented behavior and label illustrative report or future application functionality accurately.

- [ ] **Step 2: Draft 16 articles with usable verification procedures**

Use safe local or owned-environment checks. Explain evidence quality, limitations, false-positive handling, and the distinction between detected, independently verified, retest-confirmed, and inconclusive results.

- [ ] **Step 3: Apply Humanizer and individual gates**

Remove template repetition across closely related verification articles. Check that each introduction answers its distinct query and that internal anchors use descriptive text rather than generic CTA language.

- [ ] **Step 4: Validate and render Batch 5**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-5 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-5 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-5 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for 16 articles. Browser-test one stack, one tool-led, one verification, and one reporting article. Run Lighthouse on one representative article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 5: Commit Batch 5**

```bash
git add docs/editorial/blog-briefs/batch-5.md docs/editorial/blog-research/batch-5.md docs/editorial/blog-image-manifests/batch-5.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch five"
```

### Task 11: Produce Batch 6, topics 85 to 100

**Files:**

- Create: `docs/editorial/blog-briefs/batch-6.md`
- Create: `docs/editorial/blog-research/batch-6.md`
- Modify: `docs/editorial/blog-image-manifests/batch-6.json`
- Create: `apps/marketing/src/content/blog/weekly-security-scan-workflow.mdx`
- Create: `apps/marketing/src/content/blog/critical-security-finding-response.mdx`
- Create: `apps/marketing/src/content/blog/ai-generated-code-production-safety.mdx`
- Create: `apps/marketing/src/content/blog/prototype-to-production-security.mdx`
- Create: `apps/marketing/src/content/blog/ai-coding-assistant-data-privacy.mdx`
- Create: `apps/marketing/src/content/blog/review-ai-generated-pull-request.mdx`
- Create: `apps/marketing/src/content/blog/ai-app-privacy-checklist.mdx`
- Create: `apps/marketing/src/content/blog/agency-client-app-security-review.mdx`
- Create: `apps/marketing/src/content/blog/solo-founder-vibe-coding-security.mdx`
- Create: `apps/marketing/src/content/blog/secure-ai-built-internal-tools.mdx`
- Create: `apps/marketing/src/content/blog/secure-public-ai-api-endpoints.mdx`
- Create: `apps/marketing/src/content/blog/app-security-score-explained.mdx`
- Create: `apps/marketing/src/content/blog/security-scanner-false-positives.mdx`
- Create: `apps/marketing/src/content/blog/prioritize-security-findings.mdx`
- Create: `apps/marketing/src/content/blog/share-security-report-safely.mdx`
- Create: `apps/marketing/src/content/blog/exposed-api-key-incident-response.mdx`

**Interfaces:**

- Consumes: program entries 85 to 100 and every previously published article.
- Produces: 16 reviewed articles on scheduled checks, critical response, production safety, prototype promotion, assistant privacy, PR review, app privacy, agency and solo-founder needs, internal tools, public AI APIs, scores, false positives, prioritization, safe report sharing, and exposed-key recovery.

- [ ] **Step 1: Complete decision and operations briefs**

Write direct answers that help readers make a concrete decision. Avoid pretending that every decision has a universal answer. Define exact boundaries for scanner scores, reports, incident handling, and audience-specific workflow recommendations.

- [ ] **Step 2: Research and draft all 16 articles**

Use current official incident-response, credential-rotation, privacy, API, and secure-development sources. For urgent recovery content, lead with containment steps and preserve provider-specific differences rather than inventing one generic sequence.

- [ ] **Step 3: Apply Humanizer and individual approval gates**

Review for manufactured urgency, moralizing, generic optimistic conclusions, and repetitive audience personas. Keep actionable detail, mixed tradeoffs, and explicit uncertainty where context controls the answer.

- [ ] **Step 4: Validate and render Batch 6**

Run: `pnpm --filter @lyrashield/marketing blog:validate -- --release batch-6 && pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-6 && pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-6 && pnpm --filter @lyrashield/marketing typecheck && pnpm --filter @lyrashield/marketing build`

Expected: PASS for 16 articles and all cross-library links. Browser-test one operations, one decision, one audience, one score, and the exposed-key response article. Run Lighthouse on one representative article and require performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 5: Commit Batch 6**

```bash
git add docs/editorial/blog-briefs/batch-6.md docs/editorial/blog-research/batch-6.md docs/editorial/blog-image-manifests/batch-6.json apps/marketing/src/content/blog
git commit -m "feat(marketing): add authority blog batch six"
```

### Task 12: Run the 100-article integration and production-readiness gate

**Files:**

- Create: `apps/marketing/scripts/crawl-built-blog.mjs`
- Create: `apps/marketing/src/tests/blog-program-complete.test.ts`
- Modify: `apps/marketing/README.md`
- Create: `apps/marketing/BLOG_AUTHORING.md`
- Modify: `AGENTS.md`
- Modify: `PRD.md`
- Modify: `codebase.md`

**Interfaces:**

- Consumes: all 100 articles, 36 catalog images, seven release manifests, Astro build output, and the existing Cloudflare release workflow.
- Produces: deterministic proof of the full program, authoring and correction runbooks, a focused release candidate, and a production verification checklist.

- [ ] **Step 1: Write the failing completeness test**

```ts
import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"

describe("complete blog program", () => {
  it("has exactly the mapped 100 public articles", async () => {
    const { getCollection } = await import("astro:content")
    const published = await getCollection("blog", ({ data }) => !data.draft)
    expect(published).toHaveLength(100)
    expect(new Set(published.map((post) => post.id))).toEqual(
      new Set(program.map((entry) => entry.slug))
    )
  })
})
```

- [ ] **Step 2: Run the full-program test**

Run: `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-program-complete.test.ts`

Expected: PASS only when every mapped article is published and both sample drafts are gone.

- [ ] **Step 3: Implement the built-site crawler and operational docs**

The crawler reads the generated sitemap, fetches every blog URL from the local Worker, rejects non-200 responses, duplicate canonicals, missing titles or descriptions, wrong H1 or main counts, broken internal anchors, missing images, structured-data parse errors, draft discovery, absent RSS entries, and missing tag archive membership. It reports URLs without query strings.

`BLOG_AUTHORING.md` documents manifest selection, brief fields, research records, Humanizer draft and audit, image assignment, local validation, corrections, material update dates, stable anchors, and batch release commands. The marketing README documents local preview and guarded publication without claiming that content is live before deployment verification.

Update `AGENTS.md`, `PRD.md` Part C, and `codebase.md` only with verified branch truth at this stage. Merge and production truth are recorded after they occur.

- [ ] **Step 4: Run the complete local release gate**

Run:

```bash
pnpm --filter @lyrashield/marketing blog:validate -- --release all
pnpm --filter @lyrashield/marketing blog:validate:images -- --final-distribution
pnpm --filter @lyrashield/marketing blog:check-links -- --release all
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @lyrashield/marketing exec node scripts/crawl-built-blog.mjs --origin http://localhost:8787
pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-program-complete.test.ts
git diff --check
```

Expected: every command exits zero. The current repository test count may increase; report the exact count rather than copying an older checkpoint.

- [ ] **Step 5: Run full browser and performance QA on localhost**

Test the Worker-backed build in Chromium and WebKit at 390 pixels, tablet, and desktop. Cover pagination, each tag archive, direct article URLs, editorial policy, reverse navigation, dark and light themes, JavaScript disabled, slow network, missing image fallback, keyboard navigation, visible focus, 200 percent zoom, screen-reader order, code overflow, tables, FAQ details, related links, CTA handoff, header, and footer. Require no console errors, duplicate image downloads, horizontal overflow, layout jumps, broken anchors, or privacy event regressions.

Run Lighthouse on the authority article plus one representative article from each batch. Each requires performance at least 90, accessibility 100, best practices 100, SEO 100, LCP at most 2.5 seconds, and CLS below 0.1.

- [ ] **Step 6: Commit the integration gate and documentation**

```bash
git add apps/marketing/scripts/crawl-built-blog.mjs apps/marketing/src/tests/blog-program-complete.test.ts apps/marketing/README.md apps/marketing/BLOG_AUTHORING.md AGENTS.md PRD.md codebase.md
git commit -m "docs(marketing): record authority blog release gate"
```

- [ ] **Step 7: Hold the production boundary until explicit release approval**

Present the localhost URLs, article and image counts, validation output, browser findings, and Lighthouse results. Do not push, open a PR, merge, deploy, alter Cloudflare, or publish a batch whose individual and batch approvals are incomplete.

After explicit approval, push the focused branch, open the PR, require green CI, merge only after approval, let the existing guarded marketing workflow deploy, and verify the real canonical URLs, canonicals, images, schemas, sitemap, RSS, links, console, mobile layouts, and privacy-safe analytics. Then update `AGENTS.md`, `PRD.md` Part C, `codebase.md`, and `apps/marketing/README.md` with the verified merge commit, workflow run, Worker version, and production truth.
