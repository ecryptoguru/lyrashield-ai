# Task 4 final review: editorial trust and catalog image rendering

## Verdicts

- **Spec compliance: CHANGES REQUESTED.** The implementation covers the required trust page, Organization authorship, catalog image selection, article/archive `<picture>` markup, draft-safe discovery, and Markdown-aware counts. It does not yet produce correct dimensions for the selected Open Graph asset, and the specified rendered article/schema test was replaced by source-text assertions.
- **Code quality: CHANGES REQUESTED.** The production code is focused and readable, but the metadata mismatch is user-visible to crawlers/social consumers and the test strategy cannot detect it. No source files were edited during this review.

## Findings

### [P2] Open Graph and `BlogPosting.image` publish the hero dimensions for the social image

**Files and lines:**

- `apps/marketing/src/layouts/BlogPost.astro:55-56`
- `apps/marketing/src/layouts/BlogPost.astro:99-104`
- `apps/marketing/src/layouts/BlogPost.astro:141-144`
- `apps/marketing/src/content.config.ts:20-24`
- Contract evidence: `docs/superpowers/plans/2026-07-17-blog-authority-program.md:23` and `:387`

`ogImage`, `BlogPosting.image.url`, and the Twitter image all correctly select `heroImage.data.og`, whose contract is the 1200 by 630 Open Graph derivative. However, both the JSON-LD `ImageObject` and the `og:image:width` / `og:image:height` metadata use `heroImage.data.width` and `height`. Those catalog fields are fixed at 1600 by 900 for the hero derivative. The page therefore describes a 1200 by 630 file as 1600 by 900.

This can give crawlers a false aspect ratio and undermines the requirement for valid catalog image metadata. Publish 1200 and 630 for the `og` derivative, preferably by representing per-variant dimensions in the image contract (or by using explicit validated constants for this fixed derivative). Keep 1600 by 900 on the visible hero `<img>`.

### [P2] Rendering tests inspect source strings and never exercise a published article

**Files and lines:**

- `apps/marketing/src/tests/blog-rendering.test.ts:27-54`
- `apps/marketing/src/tests/blog-rendering.test.ts:56-76`
- `apps/marketing/src/tests/seo.test.ts:54-80`
- Required behavioral test: `docs/superpowers/plans/2026-07-17-blog-authority-program.md:351-376`

The new tests use `readFileSync()` plus `toContain()` checks. They prove that tokens such as `heroImage.data.og`, `"@type": author.data.kind`, `loading="eager"`, and `!entry.data.draft` occur in source, but they do not prove the emitted HTML, canonical URL, serialized JSON-LD, metadata values, image reference resolution, or discovery output. This is why the dimension defect above passes the entire focused suite.

The current integrated tree has 100 draft articles and an empty image catalog, so the production build emits no article routes; `/blog/vibe-coding-security-guide` correctly returns 404. Add a behavioral fixture or Worker-backed rendered test with one published post and one catalog image. Parse the resulting head/JSON-LD/body and assert the exact canonical, Organization author, policy link, image URLs, 1200 by 630 social metadata, 1600 by 900 visible image, eager/lazy behavior, and absence of a draft from archive, sitemap, RSS, tag, related-post, and `llms.txt` output. The plan explicitly called for a `worker.fetch()` rendering test.

## Spec checklist

| Requirement                                                                                               | Result                                            | Evidence                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve `heroImage` and fail clearly on an article                                                        | Pass                                              | `apps/marketing/src/pages/blog/[slug].astro:20-24`                                                                                                                                                                                                  |
| AVIF/WebP/JPEG article `<picture>`, alt text, 1600 by 900, eager/high-priority loading, responsive sizing | Pass                                              | `apps/marketing/src/layouts/BlogPost.astro:174-186`                                                                                                                                                                                                 |
| Lazy catalog images on archive/tag cards                                                                  | Pass                                              | `apps/marketing/src/components/BlogCard.astro:18-35`; archive and tag routes pass resolved entries                                                                                                                                                  |
| Catalog social image for Open Graph, Twitter, and `BlogPosting.image`                                     | Partial                                           | Correct URL at `BlogPost.astro:55-56,99-105,141-144`; incorrect dimensions as finding 1                                                                                                                                                             |
| Organization author type, description, URL, publisher relationship, conditional Person fields             | Pass                                              | `apps/marketing/src/layouts/BlogPost.astro:57-75,86-111`                                                                                                                                                                                            |
| Visible author policy link                                                                                | Pass                                              | `apps/marketing/src/layouts/BlogPost.astro:204-215`                                                                                                                                                                                                 |
| Editorial policy covers every required trust topic without claiming draft workflow as proof               | Pass                                              | `apps/marketing/src/pages/blog/editorial-policy.astro:35-120`                                                                                                                                                                                       |
| Policy route indexable, canonical, separate from article collection/count                                 | Pass                                              | `editorial-policy.astro:4-35`; built route has one H1, one main, index/follow, and canonical `https://lyrashieldai.com/blog/editorial-policy`                                                                                                       |
| Draft-safe archive, article static paths, related posts, tags, RSS, `llms.txt`, and sitemap               | Pass in current build                             | `[...page].astro:7-10`; `[slug].astro:6-15,29-40`; `tags/[tag].astro:6-13`; `rss.xml.ts:19-27`; `llms.txt.ts:24-28`; built sitemap contains the policy route and no draft article routes                                                            |
| Markdown-aware word count aligned with release validation                                                 | Pass                                              | `apps/marketing/src/lib/blog-content.ts:1-20` matches `scripts/blog-validation-lib.mjs:290-302`; focused parity test passes                                                                                                                         |
| Archive/tag canonical and CollectionPage/ItemList schema                                                  | Pass by inspection/build                          | `[...page].astro:15-35`; `tags/[tag].astro:23-63`                                                                                                                                                                                                   |
| Accessibility and mobile layout                                                                           | Pass by code inspection; visual proof unavailable | One main landmark via Base, one H1 per checked route, labelled navigation/sections, explicit image alt/dimensions, visible focus styles, 44px primary targets, responsive single-column policy/archive layouts, mobile TOC                          |
| Placeholder deletions                                                                                     | Acceptable integrated dependency                  | The deleted files are the two documented sample drafts, have no remaining references, and are explicitly scheduled for deletion in Task 5 (`plan:422-423`). Keep their commit ownership coordinated with Task 5 as the implementation report notes. |
| Narrow validation-test typing                                                                             | Pass                                              | `apps/marketing/src/tests/blog-validation.test.ts:174,269-277,316-324` changes types only and preserves behavior                                                                                                                                    |

## Verification performed

- `pnpm --filter @lyrashield/marketing exec vitest run src/tests/seo.test.ts src/tests/blog-rendering.test.ts src/tests/blog-validation.test.ts` — **PASS**, 27 tests in 3 files.
- `pnpm --filter @lyrashield/marketing typecheck` — **PASS**, 63 files, 0 errors/warnings/hints.
- `pnpm --filter @lyrashield/marketing build` — **PASS**; `/blog/editorial-policy` and `/blog` prerendered and `sitemap-index.xml` generated.
- `git diff --check` — **PASS**.
- Focused ESLint command — TypeScript files passed; the repository ESLint configuration ignored the seven `.astro` files and reported those as warnings, so this was not an Astro lint proof.
- Worker-backed local preview checks — `/blog/editorial-policy`, `/blog`, `/llms.txt`, and `/rss.xml` returned 200; the representative draft article returned 404. Policy and archive each emitted one H1, one main landmark, an index/follow robots directive, correct production canonical, and no draft slug in the response.
- In-app Browser classification — **invocation failed** with `No browser is available`. No standalone Playwright fallback was used, so desktop/mobile visual rendering, console health, keyboard interaction, and screenshots remain unverified in this review.

## Positive quality notes

- `markdownWordCount()` stays deliberately aligned with the release validator while excluding fenced code and Markdown syntax from the public reading estimate.
- Draft filtering is consistently server/build-side rather than being delegated to a client.
- The editorial policy is concrete about source hierarchy, inference, authorization, automation limits, corrections, stable anchors, and generated-image review.
- Organization and Person JSON-LD fields are separated cleanly, and the visible author block links accountability to the policy route.
- Existing article relationships, RSS behavior, empty archive UX, pagination, and tag navigation remain intact.

## Fix follow-up — 2026-07-17

### Final post-fix verdict

- **Spec compliance: PASS.** The selected `og.jpg` now carries 1200 by 630 Open Graph and JSON-LD dimensions while the visible hero remains 1600 by 900.
- **Code quality: PASS.** The article contract now has a real full-page Astro render regression using synthetic typed author and image entries. The test parses the emitted JSON-LD and asserts exact metadata rather than checking only source tokens.

### Changes made

- `apps/marketing/src/layouts/BlogPost.astro:17-75,86-105,136-146` now receives a resolved typed author entry, uses explicit 1200 by 630 social-image dimensions for `BlogPosting.image` and `SeoHead`, and retains the 1600 by 900 hero `<img>` dimensions.
- `apps/marketing/src/pages/blog/[slug].astro:18-30,49-64` resolves both author and hero references before rendering and fails clearly if either entry is missing. Draft path filtering is unchanged.
- `apps/marketing/src/tests/blog-rendering.test.ts:30-150` renders the real `BlogPost.astro` full page with Astro's container API and synthetic typed `authors` / `blogImages` entries. It asserts the production canonical, article meta dates, Open Graph/Twitter image and alt, exact 1200 by 630 social dimensions, responsive 1600 by 900 hero picture, policy link, one main, one H1, Organization/publisher JSON-LD, `ImageObject`, and `mainEntityOfPage`.
- `apps/marketing/vitest.config.ts:1-20` enables Astro component compilation for package-local Vitest without loading the production Cloudflare adapter. Loading the full production Astro config caused Cloudflare's Vite plugin to reject Vitest's SSR externals, so the test config deliberately uses `configFile: false`; production config is not modified.

Astro 7.0.7's container implementation ignores the documented `astroConfig.site` creation option and uses `http://localhost:4321` for site-derived URLs. The rendered fixture therefore asserts the explicit production canonical separately and uses the deterministic container origin for image, author, and publisher URLs. The production Astro build remains the origin/configuration verification path.

### Regression evidence

- RED: the first real component render failed because `BlogPost.astro` still performed its own content-collection author lookup. This proved the fixture was exercising the component rather than reading source text.
- GREEN: the route now resolves the real author entry and injects it, while the test supplies a synthetic typed Organization entry. No catalog data or article draft was added or published.
- The exact 1200 and 630 assertions cover both `og:image:*` metadata and the serialized `BlogPosting.image` object; exact 1600 and 900 assertions remain on the visible hero.

### Post-fix verification

- `pnpm --filter @lyrashield/marketing exec vitest run src/tests/blog-rendering.test.ts src/tests/seo.test.ts src/tests/blog-validation.test.ts` — **PASS**, 27 tests in 3 files.
- `pnpm --filter @lyrashield/marketing typecheck` — **PASS**, 63 files, 0 errors/warnings/hints.
- `pnpm --filter @lyrashield/marketing build` — **PASS**; policy/blog routes prerendered and sitemap generated; no draft article route was published.
- `pnpm exec prettier --write apps/marketing/src/tests/blog-rendering.test.ts apps/marketing/vitest.config.ts` — **PASS**, both files unchanged after formatting.
- Prettier cannot parse `.astro` files in this repository because no Astro Prettier plugin is installed (`No parser could be inferred`). Astro check and the production build cover those files.
- A direct `tsc --noEmit` attempt is blocked by the repository's existing TypeScript 6 `baseUrl` deprecation diagnostic; the supported `astro check` typecheck passed.
