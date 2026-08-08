# BLOG_AUTHORING.md — Authority Blog Operating Guide

This guide is the publishing contract for the LyraShield AI authority blog. It complements `README.md`, which owns local and deployment operations. Code, the content schema, and the release manifest win if this guide drifts.

## Current release boundary

The program maps **161 published articles** across ten releases (`authority`, `batch-1` through `batch-10`) and a **75-image** source-artwork library. `apps/marketing/scripts/blog-validation-lib.mjs` declares this once as `PROGRAM_ARTICLE_COUNT` (161) and `IMAGE_CORPUS` (`{ authority: 1, shared: 74 }`); do not hardcode either number elsewhere. All mapped entries are `draft: false` in the current program. This file's boundary is only as current as the last time someone updated it after a merge — trust `blog-program.json` and the live validator output over this prose if they disagree.

The editorial policy is a permanent public resource, not one of the mapped articles. A sibling content collection, `/compare` (13 competitor-comparison pages under `src/content/compare/*.md`, membership in `src/content/compare-program.json`, gated by `compare:validate`), is governed the same way but counted separately — it is not part of `PROGRAM_ARTICLE_COUNT`.

**Publishing is tranche-merge, not draft-flag scheduling.** There is no way to merge an article to `main` in a not-yet-live state and flip it live later: `draft: true` on a program-mapped article fails the release check, breaks the program-completeness test, and — because the internal-link validator only resolves `/blog/` links against non-draft posts — turns every other published post's link into it into an `unpublished internal dependency` failure. `pubDate` has no publish-gating effect anywhere in the codebase; it is a sort key and RSS field only, so a future `pubDate` publishes immediately and sorts to the top of the blog index rather than delaying anything. If you need a staggered publish calendar, split the release into multiple independently-complete tranches (each with its own PR, its own program-count bump, and its own image-manifest updates) and merge them on their scheduled days — the merge calendar is the publish calendar.

## Sources of truth

- `src/content/blog-program.json` owns the release entries, slugs, titles, queries, clusters, target lengths, batches, and CTA requirements.
- `docs/editorial/blog-briefs/<batch>.md` owns search intent, reader problem, angle, outline, internal-link targets, FAQ questions, and claim boundaries.
- `docs/editorial/blog-research/<batch>.md` owns the claim-to-source map, primary-source URLs, access dates, quotations, and unresolved verification notes.
- `docs/editorial/blog-image-manifests/<release>.json` maps an image ID and its concept, prompt, crop notes, source hash, usage count, and approval state to each article in a release.
- `src/content/blog-images/images.json` owns the canonical derivative paths, alt text, cluster, and dimensions loaded by Astro.
- `src/content/blog/*.mdx` owns the article body and validated frontmatter.
- `src/pages/editorial-policy.astro` owns the public correction, sourcing, and authorship policy.

Do not publish an ad hoc article outside the manifest. The eleven defined releases are `authority` followed by `batch-1` through `batch-10`; use the `--release` selector on `blog:validate` and `blog:validate:images` when validating one (`blog:validate:mdx`, `blog:validate:offline`, and `compare:validate` always run against the whole repository — they take no `--release` flag).

## Non-negotiable claim rules

1. Never mention the upstream engine or publish pricing, customer, benchmark, accuracy, or false-positive claims without approved evidence.
2. Keep detected, independently verified, retest-confirmed, and inconclusive states distinct. Confidence is triage metadata, not proof.
3. Do not imply automatic PR execution. A fix proposal remains approval-bound, and PR execution remains fail-closed until a server-generated patch is bound to the exact approval. Describe this as **"approval-gated"** or **"not unattended fixes"** — never "automatic fixes" or "automatic PR". Both phrases are hard-blocked by `PROHIBITED_CLAIMS` in `apps/marketing/scripts/blog-validation-lib.mjs`, and the regex has no concept of negation: a disclaimer sentence like _"proposals requiring review, not automatic fixes"_ still trips it, because the phrase itself is present. Write around the phrase entirely rather than trying to negate it.
4. Describe the Lite Check as a bounded passive review of a public surface. It does not authenticate, fuzz, exploit, prove RLS, or cover the full application.
5. Never invent incidents, scans, customers, quotes, metrics, first-person experience, or source conclusions.
6. Vulnerability examples must be inert, minimal, clearly labeled, and must not target a real unpatched system.
7. Name the product **LyraShield AI** on first mention. Use **LyraShield** only after that.
8. State the product's status honestly: **open beta, live with open registration.** Never describe it as pre-launch or invite a reader to "join the waitlist" — say "create an account at LyraShield AI" or equivalent. Separate what is live today from what is roadmap explicitly; do not blur the two into one claim.
9. Every external URL is checked against a small denylist of previously-dead links (`DEAD_URLS` in `apps/marketing/scripts/blog-offline-gates.mjs`) before it can ship. If a citation resolves to one of those, use the paired replacement rather than the original — the same handful of dead URLs (an old CWE Top 25 archive path, a stale GitHub SARIF-upload path, an outdated MCP spec path, and others) has been reintroduced from regenerated copy multiple times across this program.

## Brief and research record

Before drafting, the brief must record:

- the primary query and search intent;
- the reader's concrete problem and expected decision;
- a distinct angle that avoids cannibalizing another mapped article;
- required entities, standards, and official or primary sources;
- the authority page, product/tool page, and related articles to link;
- two to four useful FAQ questions;
- the assigned image ID and its narrative purpose;
- risky claims, limitations, and statements that require explicit hedging.

The research record must map each material claim to a source, include the access date, prefer specifications and first-party documentation, and mark unresolved conflicts. Supporting articles require at least three credible sources, including at least two official or primary sources. Authority articles require at least eight credible sources and should generally run 2,500–3,000 words; supporting articles should generally run 1,200–1,500 words. Length never substitutes for value.

## Frontmatter contract

Use the current content schema and the stable six-tag taxonomy: `vibe-coding-security`, `access-control`, `web-security`, `supply-chain`, `agent-security`, `verification` (`STABLE_TAGS` in `apps/marketing/scripts/blog-validation-lib.mjs`). Any other value fails validation. Keep new work unpublished by default.

```yaml
---
title: "A precise title that matches reader intent"
description: "A standalone 70–160 character answer that accurately describes the article."
pubDate: 2026-07-17
updatedDate: 2026-07-17 # omit until a material post-publication change
author: lyrashield-team
tags: ["vibe-coding-security", "agent-security"]
draft: true
heroImage: "supply-chain-02"
faq:
  - q: "What decision should the reader make?"
    a: "A concise answer that is also visible in the article."
---
```

Quote any `title` or `description` value that contains a colon followed by a space (`"Set it up step by step: CLI, then config"`). Astro parses frontmatter with a real YAML parser and reads an unquoted `key: value: more text` as a nested mapping, which fails `astro check` with `bad indentation of a mapping entry` and no article-level error message — `blog:validate:offline` catches this locally before it reaches CI.

The manifest, frontmatter, image manifest, and image catalog must agree. Do not hand-edit generated image paths or introduce a one-off tag.

## Article structure and readability

- The layout provides the only H1. Start the body with a direct 40–80 word answer, without throat-clearing.
- Use descriptive H2 and H3 headings in order. After publication, heading IDs are an API: preserve stable anchor text or add an explicit compatibility plan.
- Make each section useful on its own. Explain the mechanism, show the failure mode, give a safe remediation path, and state limitations.
- Link descriptive anchor text to the authority page, a relevant tool or methodology page, and genuinely related articles. Do not manufacture links merely to hit a count.
- Use language-tagged code fences and label insecure snippets. Do not include operational exploit payloads.
- Add two to four visible FAQ answers only when they resolve real follow-up questions. The visible content and structured data must match.
- Prefer plain language, concrete nouns, and varied sentence structure. Remove empty scene-setting, repeated conclusions, faux quotations, and inflated transitions.

## Humanizer review

Every article gets three editorial passes:

1. Draft for technical completeness, reader utility, claim accuracy, and logical flow.
2. Review the draft with the exact prompt: **“What makes the below so obviously AI generated?”** Record the specific tells, then fix them rather than merely rephrasing a paragraph.
3. Run a final human scan for unsupported certainty, repetitive cadence, stock phrases, em/en dashes, fake first-person experience, vague attribution, and conclusions that restate the introduction.

Humanizer work must not weaken a technical boundary or replace a precise term with marketing language.

## Image workflow

The program plans 75 text-free source artworks for 161 articles: one exclusive authority image and 74 shared images. `IMAGE_CORPUS` in `apps/marketing/scripts/blog-validation-lib.mjs` declares the corpus size once; there is no longer one fixed reuse shape like "29 images at three uses, six at two" — the enforced rule on every commit is that a manifest entry's declared `usageCount` matches its image's actual assignment count, and every image's usage stays within `1` to `MAX_SHARED_IMAGE_USAGE` (currently 3). A new tool's checklist and workflow post share one image; both must land in the same commit for that image's usage count to be correct at every point in history — do not split a tool's pair across two releases. Reuse is intentional, but the canonical alt text, caption, dimensions, crop intent, and source identity must remain consistent for an image ID.

- Keep 2048 px creative masters under the ignored `apps/marketing-motion` workspace.
- Commit only the derived website formats listed in the image catalog.
- Produce all five required variants and verify landscape, social, and portrait crops.
- Run visual QA for legibility, composition, brand fit, accidental text, logos, people, artifacts, and unsafe security imagery.
- Derive `sourceHash` and catalog metadata from the approved master after variants are produced. Never guess a hash or edit a derived asset by hand.
- Use the assigned image only. Changing the image requires updating the batch manifest, program manifest, article frontmatter, and canonical image catalog together.

## Local validation

Validate the selected release first:

```bash
pnpm --filter @lyrashield/marketing blog:validate -- --release batch-1
pnpm --filter @lyrashield/marketing blog:validate:images -- --release batch-1
pnpm --filter @lyrashield/marketing blog:check-links -- --release batch-1
```

Then run the whole-repository gates, none of which take a `--release` flag:

```bash
pnpm --filter @lyrashield/marketing blog:validate:mdx
pnpm --filter @lyrashield/marketing blog:validate:offline
pnpm --filter @lyrashield/marketing compare:validate
```

`blog:validate:mdx` catches an inline-code span left unterminated in prose, which lets a stray `${VAR}` or `{...}` leak into a live MDX expression — this compiles cleanly and only fails `astro build` at prerender, with no file name in the error. `blog:validate:offline` pairs the `DEAD_URLS` denylist with the unquoted-YAML-scalar check described above. `compare:validate` is the equivalent release gate for the `/compare` collection if the change touches it. All three are wired into CI; `blog:check-links` (~50 live third-party requests) deliberately is not, so it must be run by hand — CI going green is not proof the article's external links resolve.

Then run the marketing quality gate:

```bash
pnpm format:check
pnpm --filter @lyrashield/marketing lint
pnpm --filter @lyrashield/marketing typecheck
pnpm --filter @lyrashield/marketing test
pnpm --filter @lyrashield/marketing build
git diff --check
```

The exact-completeness test (`blog-program-complete.test.ts`, asserting `PROGRAM_ARTICLE_COUNT` published articles) is a final local-release condition. New articles remain drafts by default; do not change a new entry's draft state without explicit approval. There is no draft-flag publish-scheduling path — see "Current release boundary" above — so a staggered rollout means multiple independently-complete tranches merged on their scheduled days, not one merge with some entries held back as drafts.

After building, start the production-shaped Worker preview in one terminal:

```bash
pnpm --filter @lyrashield/marketing preview
```

In another terminal, crawl the built blog:

```bash
node apps/marketing/scripts/crawl-built-blog.mjs --origin http://localhost:8787
```

The crawler checks local sitemap membership, status codes, unique canonicals, titles and descriptions, one H1 and main landmark, stable anchors, image availability, JSON-LD parsing, draft exclusion, RSS membership, and tag membership. Its reports remove query strings and fragments.

## Corrections and material updates

- Fix a harmless typo through the normal review path; a typo alone does not require `updatedDate`.
- For a material factual, technical, recommendation, or claim-boundary change, recheck every affected source, set `updatedDate`, and add a visible correction note when the previous text could have misled a reader.
- Never silently rewrite a published claim, remove a limitation, or break a cited heading anchor. Preserve the old boundary in review history and explain the change in the PR.
- Re-run the article, image, internal-link, structured-data, sitemap, RSS, and local crawler checks after a correction.

## Approval and publication

Publication requires explicit founder approval for each article or clearly named batch. Keep draft flips isolated and reviewable. After approval:

1. Flip only the approved manifest entries and matching frontmatter.
2. Run the selected-release checks, the exact-completeness gate when applicable, full repository gate, Worker preview crawl, rendered browser QA, and performance/accessibility checks.
3. Open a focused PR; never push directly to `main`.
4. Let the existing guarded marketing workflow deploy only after green CI and approval.
5. Verify live canonical URLs, sitemap and RSS membership, tag archives, images, structured data, console output, analytics privacy, and mobile rendering.
6. Only after live proof, update branch-only documentation to merged and production truth.

## Review checklist

- [ ] Manifest, brief, research record, frontmatter, and image assignment agree.
- [ ] Direct answer is accurate, useful, and readable without surrounding context.
- [ ] Material claims have current primary or official sources and access dates.
- [ ] Evidence-state, scanner, fix-proposal, and product-status boundaries are literal.
- [ ] Humanizer passes are complete and documented.
- [ ] Internal links are useful; external links lead to authoritative sources.
- [ ] Image variants, crops, alt text, catalog metadata, and visual QA pass.
- [ ] FAQ content is visible, non-duplicative, and consistent with JSON-LD.
- [ ] Draft remains true unless explicit approval is recorded.
- [ ] Selected release checks, build, Worker crawler, browser QA, and release gates pass.
