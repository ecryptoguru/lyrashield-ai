# LyraShield AI — SEO / AEO / GEO Megaplan

Date: September 18, 2026

Status: review and execution plan. Execution state is tracked in
[`2026-09-18-seo-aeo-geo-ledger.md`](./2026-09-18-seo-aeo-geo-ledger.md) — branches, commit SHAs,
verification results, and PR status live there; this document stays a point-in-time plan record.

## Goal

Make every indexable page on `lyrashieldai.com` easier for search engines and answer engines to
retrieve, understand, quote, and cite — without weakening the claim boundary, the indexability gates,
the trailing-slash canonical contract, or founder-approved search copy — and leave behind an
automated gate so the same class of defect cannot return silently.

Scope: `apps/marketing` only. The authenticated app origin (`app.lyrashieldai.com`) deliberately
serves `Disallow: /` with per-page `robots: noindex`; that posture is unchanged here.

## Relationship to previous work

The site already carries the foundations: indexability-gated `robots.txt`, sitemap with real
`lastmod`, dated `llms.txt`, `agents.md`, `Organization`/`WebSite` graph, per-page `WebPage` +
`FAQPage` + `BreadcrumbList`, `BlogPosting` with author and `wordCount`, `TechArticle` on docs, a
301 trailing-slash canonicalisation layer, and a post-deploy Lighthouse gate on the homepage.

This plan therefore contains **surgical fixes, not a rebuild**. It is the depth pass that follows the
September SEO/AEO/conversion work (`f2b7d8fd`, `79c268ac`, `f8196dc1`). The audit deliberately
re-verified everything those passes touched and found it sound — see "Verified NOT findings". Do not
"fix" those.

## Review snapshot

- Audit date: 2026-09-18. Environment: **production** (`lyrashieldai.com`) plus local source at
  `origin/main` = `171e225d`.
- Method: full crawl of all **241 URLs** in `sitemap-0.xml` (HTTP status, title, description,
  canonical, `h1` count, JSON-LD presence, robots directive, word count); targeted header/redirect
  probes; `rss.xml`, `robots.txt`, `llms.txt`, `agents.md`, `webmcp-controls.json` readback; frontmatter
  scan of all 161 blog posts; source review of every layout, page, schema block and CI gate.
- Protocol: read-only. Nothing was created, edited, deleted, sent, or saved on production. No
  analytics, no account, no form submission.
- Evidence is reproducible with the commands in "Verification" — no screenshot corpus is required,
  because every finding below is a deterministic HTTP or source fact.

## Executive verdict

The site is in unusually good technical health. Across all 241 sitemap URLs there were **zero
non-200 responses, zero duplicate titles, zero duplicate descriptions, zero duplicate canonicals, no
page without a JSON-LD block, and no page with a missing or duplicated `h1`**. Canonical, `hreflang`,
`og:url` and the sitemap agree everywhere except the homepage's trailing slash (SF-07).

The gaps that matter cluster in five places:

1. **Crawler eligibility is under-declared.** `robots.txt` names five AI agents — all of them either
   training crawlers or general-purpose fetchers. The _retrieval_ agents that actually produce
   citations (OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot, Perplexity-User,
   GoogleOther, Applebot, DuckAssistBot, meta-externalagent, and others) are unlisted, so a future
   tightening of the wildcard would silently revoke citation access (SF-02).
2. **The machine-readable layer drifts from the site.** `llms.txt` lists 4 of 13 comparison pages,
   omits `/webmcp` and `/demo` from its URL index, and is dated 2026-09-13 against content through
   2026-09-17 — because its compare and docs lists are hand-maintained arrays (SF-04). The RSS feed
   emits trailing-slash links that every one of them 301-redirects (SF-05).
3. **Entity signals are thin.** `Organization.sameAs` is **empty in production**, there is no
   `contactPoint`, and the schema `logo` is an SVG when Google's logo guidance requires a raster
   image — while a 1024×1024 `logo.png` already exists unused (SF-10, SF-11). Across 161 posts the
   only author entity is an Organization; no human with credentials is named on security guidance
   (SF-13).
4. **The content library does not link to the product.** 0 of 161 posts link to `/pricing`, 0 to
   `/agents`, and only 15 to `/methodology`. The single largest asset on the site passes no equity and
   no reader to the pages that convert (SF-20).
5. **Nothing enforces any of it.** The only built-HTML crawler covers `/blog*` and is not run in CI;
   the SEO unit test is source-grep only; title/description limits, OG coverage, and
   robots/llms/sitemap agreement are unchecked (SF-24, SF-25).

Everything else is bounded metadata hygiene: 30 titles and 11 descriptions over the enforced limits,
one shared OG image across ~40 pages, a promise/evidence mismatch on `/research`, and a handful of
thin pages.

## Prioritization method

Priority combines eligibility impact (can the page be retrieved at all), reach (how many URLs are
affected), evidence strength, and fix cost:

- **P0** — the page makes a claim it cannot support, or the defect removes a surface from retrieval.
- **P1** — affects retrieval, entity understanding, or the crawl path of many pages.
- **P2** — bounded metadata or linking hygiene with a known workaround.
- **P3** — record-only; revisit if measurement justifies it.

## Findings register

| ID    | Priority | Surface          | Finding                                                                                                                                                              | Evidence                                                | Decision                                       |
| ----- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| SF-01 | P0       | `/research`      | Title and description promise "statistics … observed across real scans"; the page says "Research in progress" and publishes none                                     | live: description 178 chars, body 589 words             | Wave 3 — reword to match reality, keep indexed |
| SF-02 | P1       | `robots.txt`     | Only 5 AI agents named (GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended); retrieval agents unlisted                                                         | live `robots.txt`                                       | Wave 1                                         |
| SF-03 | P1       | trust surfaces   | `/.well-known/security.txt` returns 404 although `security@lyrashieldai.com` and `/security-reporting` exist                                                         | live 404                                                | Wave 1                                         |
| SF-04 | P1       | `llms.txt`       | 4/13 compare pages listed; `/webmcp` and `/demo` absent from URL index; `Last updated: 2026-09-13` vs content through 2026-09-17; compare/docs lists hand-maintained | live `llms.txt`, `src/pages/llms.txt.ts:138-176`        | Wave 1 — derive from collections               |
| SF-05 | P1       | `rss.xml`        | Every item link carries a trailing slash and 301s (40 occurrences); `@astrojs/rss` defaults `trailingSlash: true`                                                    | live feed; `node_modules/@astrojs/rss/dist/index.js:28` | Wave 1 — `trailingSlash: false`                |
| SF-06 | P2       | routing          | `/blog/1` returns 404 while `/blog/2…17` are real routes                                                                                                             | live                                                    | Wave 1 — 301 to `/blog`                        |
| SF-07 | P2       | sitemap          | Homepage `<loc>` is `https://lyrashieldai.com` but its canonical is `https://lyrashieldai.com/` — the only loc/canonical mismatch on the site                        | live sitemap vs canonical                               | Wave 1                                         |
| SF-08 | P2       | sitemap          | Image namespace declared, no `<image:image>` entries for the 161 blog OG images                                                                                      | live sitemap                                            | Wave 1 (bounded)                               |
| SF-09 | P2       | discovery        | No Google/Bing verification tag support, no IndexNow key or deploy ping                                                                                              | live HTML, repo grep                                    | Wave 1                                         |
| SF-10 | P1       | `Organization`   | `sameAs` empty in production (`PUBLIC_X_URL: ""`); no `contactPoint`, `foundingDate` or `legalName`                                                                  | live JSON-LD                                            | Wave 2 (+ founder input)                       |
| SF-11 | P1       | `Organization`   | Schema `logo` is `/logo.svg`; Google's logo guidance requires a raster image; `/logo.png` (1024×1024) exists unused                                                  | live JSON-LD, `public/logo.png`                         | Wave 2                                         |
| SF-12 | P2       | `SeoHead`        | `twitter:site` never emitted (depends on the empty `PUBLIC_X_URL`)                                                                                                   | live HTML                                               | Wave 2                                         |
| SF-13 | P1       | blog E-E-A-T     | Only author entity across 161 posts is the Organization "LyraShield Team"; no named human with credentials                                                           | `src/content/authors/authors.json`                      | Wave 2 — **founder decision**                  |
| SF-14 | P2       | structured data  | `/pricing` has no `BreadcrumbList`; `/demo`, `/support`, `/security-reporting` have no page-level entity                                                             | source grep                                             | Wave 2                                         |
| SF-15 | P1       | docs metadata    | 4 docs titles render over 60 chars (68 / 71 / 70 / 67)                                                                                                               | live                                                    | Wave 3                                         |
| SF-16 | P1       | blog metadata    | 95 titles render over 60 chars with the 23-char `" \| LyraShield AI Blog"` suffix (57 > 65, 26 > 70)                                                                 | frontmatter scan of 161 files                           | Wave 3                                         |
| SF-17 | P1       | metadata         | 11 descriptions exceed 160 chars: docs ×6 (227 / 223 / 202 / 185 / 167 / 163), `/pricing` 164, `/research` 178, `/vibe-security-50` 165, `/blog/tags/*` 192          | live                                                    | Wave 3                                         |
| SF-18 | P1       | social cards     | All ~40 non-blog pages share one `/og/og-default.png`; only blog posts have unique cards                                                                             | live (40 pages)                                         | Wave 3 — static template set                   |
| SF-19 | P2       | blog validation  | Duplicate FAQ question inside `claude-code-security-workflow.mdx` → duplicated `FAQPage` entries; validator has no duplicate-question rule                           | `blog-validation-lib.mjs:494-506`                       | Wave 3                                         |
| SF-20 | P1       | internal linking | 0/161 posts link to `/pricing`, 0 to `/agents`, 15 to `/methodology`                                                                                                 | grep over `src/content/blog`                            | Wave 4                                         |
| SF-21 | P2       | internal linking | `/demo` reachable only from a homepage section; absent from header and footer navigation                                                                             | `Header.astro`, `Footer.astro`                          | Wave 4                                         |
| SF-22 | P2       | internal linking | `BlogCta` is only the product-updates form; no product path from any post                                                                                            | `src/components/BlogCta.astro`                          | Wave 4                                         |
| SF-23 | P2       | thin pages       | `/support` 292w, `/security-reporting` 308w, `/demo` 366w, `/docs/approvals` 501w, `/research` 589w, `/agents` 627w                                                  | live word counts                                        | Wave 4 (bounded, no new claims)                |
| SF-24 | P1       | guardrails       | No automated site-wide built-HTML gate; `crawl-built-blog.mjs` covers only `/blog*` and is not run in CI                                                             | `scripts/`, `ci.yml`                                    | Wave 1 — gate first                            |
| SF-25 | P2       | guardrails       | No rendered title/description limit, OG-coverage, or robots/llms/sitemap agreement checks                                                                            | repo                                                    | Wave 1                                         |
| SF-26 | P3       | CI               | Post-deploy Lighthouse gate covers only the homepage                                                                                                                 | `ci.yml:710`                                            | Wave 1 — extend to 5 pages                     |
| SF-27 | P3       | performance      | Hero image ships a single 1600×900 candidate with no responsive `srcset` widths                                                                                      | live HTML                                               | Backlog                                        |
| SF-28 | P3       | internal linking | `/blog/editorial-policy` not linked from the `/blog` hub (reachable from post footers and `llms.txt`)                                                                | live                                                    | Wave 4                                         |

### Verified NOT findings

Re-checked and deliberately left alone:

- One `h1`, one `main`, and a parseable JSON-LD block on all 241 sitemap URLs.
- No duplicate titles, descriptions, or canonicals anywhere on the site.
- `noindex` correctly scoped: `/terms`, `/terms-of-sale`, `/404`, `/docs/index`, and blog pagination
  (which canonicalise to `/blog` with `rel=prev`/`next`).
- `max-image-preview:large`, `max-snippet:-1` on every indexable page.
- 301 trailing-slash canonicalisation and the `www` → apex redirect, both with path and query
  preservation.
- Blog answers: the validator already enforces a 40–80 word direct answer, word-count bounds, FAQ
  count 2–4, unique descriptions, and a 1600×900 image catalogue.
- `robots.txt` returning `Disallow: /` on non-indexable preview builds; `llms.txt` returning 404
  there; sitemap omitting `/scan` when no scanner is configured.
- Security headers, CSP, HSTS preload, and `X-Robots-Tag: noindex` on `/api/*`.
- `Organization` founder `Person` with LinkedIn/GitHub/X `sameAs` on `/about` and in the site graph.

## Waves

Four focused branches, each an independently shippable PR. Every wave uses a focused branch and PR,
preserves unrelated work, and stops when executable evidence no longer proves the change.

### Wave 1 — gate, eligibility, machine-readable surfaces (PR A)

1. **Site-wide built-HTML gate first**, so waves 2–4 are enforced as they land:
   - `apps/marketing/scripts/crawl-built-site.mjs` reusing the exported helpers from
     `crawl-built-blog.mjs` (`extractSitemapLocations`, `inspectHtml`, `validatePageFacts`,
     `sanitizeReportUrl`). Per sitemap URL: status, one `h1`/one `main`, canonical == URL (homepage
     slash normalised), unique title/description, title ≤ limit, description ≤ 160, OG image present
     with `og:image:width`/`height`, ≥1 page-level JSON-LD type, robots directive consistent with
     sitemap membership, internal links resolve.
   - `apps/marketing/scripts/seo-baseline.json` — an explicit allowlist of current violations
     (path → rule → reason → owning wave). The gate fails on anything not baselined; each later wave
     deletes its own entries; Wave 4 empties the file.
   - `apps/marketing/tests-browser/seo.e2e.ts` runs the crawl against the existing Playwright
     `webServer` (`pnpm preview` → wrangler on `127.0.0.1:8787`), so it executes inside the existing
     `test:browser` CI step with no new infrastructure.
   - New `seo:crawl` package script, documented in `apps/marketing/README.md`.
2. **`src/pages/robots.txt.ts`** — grouped `User-agent` stanzas: wildcard allow; explicit allow for
   every retrieval agent in SF-02; a comment block stating the training-crawler posture (GPTBot,
   ClaudeBot, CCBot, Google-Extended remain allowed by decision). Keep the `PUBLIC_INDEXABLE` gate.
   No `Content-Signal` directive in this plan.
3. **`public/.well-known/security.txt`** — `Contact: mailto:security@lyrashieldai.com`, `Expires`,
   `Canonical`, `Policy: https://lyrashieldai.com/security-reporting`, `Preferred-Languages: en`,
   plus a `_headers` cache rule.
4. **`src/pages/llms.txt.ts`** — derive compare links from the `compare` collection (as blog posts
   already are); add `/webmcp`, `/webmcp-controls.json`, `/demo`, `/blog/tags/*` and
   `/blog/editorial-policy` to the URL index; add a short "How to cite" block; bump
   `LLMS_TXT_DATE_FLOOR` per its documented convention while keeping `latestContentDate()` derived
   from content, never build time.
5. **`src/pages/rss.xml.ts`** — `trailingSlash: false`, plus a `lastBuildDate` derived from the newest
   post rather than `new Date()`.
6. **Redirects** — `/blog/1` → `/blog` (301) in `src/middleware.ts` and the generated `_redirects`
   block; regenerate with `redirects:write`; `validate-redirects` and the `seo.test.ts`
   route-enumeration assertions must still pass.
7. **`astro.config.mjs`** — normalise the homepage sitemap `<loc>` to the canonical form; emit
   `<image:image>` entries for blog hero images from the content collection.
8. **Discovery plumbing** — `SeoHead.astro` emits `google-site-verification` / `msvalidate.01` only
   when the corresponding env var is set (added to the env schema and `wrangler.jsonc` as empty
   defaults); `scripts/indexnow.mjs` plus a key-file convention and a non-fatal post-deploy CI step.
9. **Lighthouse coverage** — extend the post-deploy step from the homepage to `/pricing`, `/agents`,
   `/scan`, `/webmcp` and one blog post, keeping the current thresholds and `continue-on-error` until
   the first green run.

### Wave 2 — entity and structured data (PR B)

- `src/layouts/Base.astro` site graph: `logo` becomes an `ImageObject` pointing at `/logo.png` with
  `width`/`height` (the SVG stays for the UI); add `contactPoint` for support and one for security
  reports; add `sameAs` **only** for profiles that genuinely exist (blocked on founder input — never
  invent URLs); add `foundingDate`/`legalName` only if supplied.
- `SeoHead.astro`: emit `twitter:site` when a handle is configured.
- `src/pages/pricing.astro`: add `BreadcrumbList`.
- `src/pages/demo.astro`, `support.astro`, `security-reporting.astro`: add `WebPage` +
  `BreadcrumbList` from their existing titles and descriptions.
- Author entity (SF-13): present the choice — strengthen the Organization author, or attribute posts
  to a named `Person` where that is factually true. No speculative attribution.
- Extend the Wave 1 gate so every indexable page must emit at least one page-level JSON-LD type and a
  `BreadcrumbList` where a hierarchy exists.

### Wave 3 — metadata limits, social cards, promise alignment (PR C)

- **`src/lib/og-images.ts`** — a route-prefix → card map consumed by `Base.astro` when a page passes
  no explicit `ogImage`. Ship 8–10 static 1200×630 cards in `public/og/` (pricing, compare, tools,
  docs, agents, methodology, webmcp, scan, ai-safety, blog hub). Add `/og/*` to `public/_headers` as
  `public, max-age=31536000, immutable`.
- **Titles** — shorten the 4 docs titles (SF-15); change the blog title template in
  `src/layouts/BlogPost.astro` from `" | LyraShield AI Blog"` to `" | LyraShield AI"`, then rewrite
  only the posts still over 65 rendered characters (SF-16), preserving each post's leading keyword.
- **Descriptions** — trim the 11 over-length descriptions to ≤ 160 without dropping the primary
  entity or the qualification (SF-17).
- **`/research`** — reword title, description and lede to describe what the page is today
  (methodology, privacy handling, planned research areas, how to cite), keep it indexed, and record
  the publish-statistics work as a later, founder-gated item (SF-01).
- **FAQ dedupe** — fix the duplicate question and add a duplicate-question rule to
  `blog-validation-lib.mjs` with a unit test (SF-19).
- Enforce the limits in the gate: title ≤ 60 rendered for non-blog pages, ≤ 65 for blog posts,
  description ≤ 160 site-wide; drain the matching baseline entries.

### Wave 4 — internal linking, thin pages, strict enforcement (PR D)

- `src/layouts/BlogPost.astro`: add a compact "next steps" block (Pricing · For coding agents ·
  Methodology · Free Lite Check) using existing labels — one file that gives all 161 posts a product
  path (SF-20, SF-22). No new claims.
- `src/components/BlogCta.astro`: the same product links beside the product-updates form.
- `src/components/Footer.astro` and the header menus: add `/demo`, respecting the documented
  mobile-menu height constraint and re-running `tests-browser/theme.e2e.ts` (SF-21). Add
  `/blog/editorial-policy` to the `/blog` hub (SF-28).
- Thin pages (SF-23): only where the fact ledger already supports it — `/support` and
  `/security-reporting` point at existing docs, `security.txt` and contact addresses; `/demo` states
  the booking constraints already published by `MYRA_COPY`/`MYRA_LIMITS`; `/docs/approvals` and
  `/agents` link existing sections. Anything needing new evidence stays out and is recorded instead.
- Empty `seo-baseline.json`, flip the gate to strict, confirm CI green with no allowlist.

### Backlog (recorded, not scheduled)

Responsive hero `srcset` widths; CSS bundle split; `/compare` and `/tools` hub depth; dynamic per-page
OG generation; `Content-Signal` policy header; `HowTo` schema removal (Google retired HowTo rich
results in 2023 — harmless, low value); publishing anonymized scan statistics on `/research`.

## Verification

Per wave, from `apps/marketing` (note: root `vitest` excludes `apps/marketing/src/tests/**`, so the
filtered command is required):

```bash
pnpm --filter @lyrashield/marketing lint
pnpm --filter @lyrashield/marketing typecheck
pnpm --filter @lyrashield/marketing exec vitest run
pnpm --filter @lyrashield/marketing blog:validate && pnpm --filter @lyrashield/marketing blog:validate:images
pnpm --filter @lyrashield/marketing blog:validate:mdx && pnpm --filter @lyrashield/marketing blog:validate:offline
pnpm --filter @lyrashield/marketing compare:validate && pnpm --filter @lyrashield/marketing validate-redirects
pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing preview            # terminal 1
node apps/marketing/scripts/crawl-built-site.mjs --origin http://localhost:8787   # terminal 2
node apps/marketing/scripts/crawl-built-blog.mjs --origin http://localhost:8787
pnpm --filter @lyrashield/marketing test:browser
pnpm format:check
```

Post-deploy readback on the exact SHA: `curl -sSI` on `/robots.txt`, `/llms.txt`, `/rss.xml` and
`/.well-known/security.txt`; assert feed links carry no trailing slash; assert the `Organization`
block now carries `logo.png`, a `contactPoint` and non-empty `sameAs`; assert the homepage sitemap
`<loc>` matches its canonical; re-run Lighthouse on the five pages.

### Measurement protocol (design only — not built)

Freeze 12–20 queries across four intents (brand, category, comparison "X vs LyraShield", problem "how
do I secure an AI-built app"). Run each on ChatGPT, Claude, Perplexity and Gemini plus Google AI
Overview results, same location and time window, at least three runs, before and after the deploy.
Record brand mentions, citations, and answer accuracy separately. These edits may improve clarity and
extractability; they do not guarantee retrieval, mention, citation, ranking, traffic, or coverage.

## Risks

- **Title rewrites touch established search copy.** Mitigation: only titles above the limit change,
  the leading keyword is preserved, and no `description` that already fits is touched.
- **`robots.txt` is a public policy surface.** The change is additive and reversible; the training
  posture is unchanged by decision, and the reasoning is committed as a comment so a future
  tightening cannot silently revoke citation access.
- **New OG assets** are static files with no runtime cost, but add 8–10 files to `public/`; the gate
  asserts exactly 1200×630 and the size budget.
- **IndexNow ping** depends on a live deploy and a hosted key file; keep it non-fatal so a network
  failure cannot fail a release.
- **The e2e crawl adds CI time.** Bound concurrency, skip image fetching outside `/blog`, reuse the
  Playwright `webServer`, and keep it under ~90 seconds.
- **workerd constraints**: no `node:fs` at render time; derive data at config/build time (the
  `__MARKETING_SOURCE_DATES__` pattern) or from content collections.

## Founder decisions required

| #   | Decision                                                                                      | Blocks                                                                 |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Verified profile URLs for `Organization.sameAs` (GitHub org, LinkedIn company page, X handle) | Wave 2 `sameAs` (everything else in Wave 2 ships without it)           |
| 2   | `foundingDate` / `legalName` / registered address, if any should be published                 | Wave 2 Organization fields                                             |
| 3   | Named human author for blog posts vs strengthening the Organization author                    | Wave 2 author entity                                                   |
| 4   | Google/Bing verification codes and IndexNow key generation (account-side actions)             | Wave 1 discovery plumbing verification only — the code ships env-gated |
| 5   | Whether to publish anonymized scan statistics on `/research`, and when                        | Later, founder-gated item; Wave 3 only rewords                         |

## Off-site runbook (outside the repo)

Verify `lyrashieldai.com` in Google Search Console (DNS, or the HTML tag that now renders when the env
var is set) and submit `sitemap-index.xml`. Register Bing Webmaster Tools — it drives Microsoft
Copilot citations — submit the same sitemap, and enable IndexNow with the committed key. Claim only
profiles that genuinely exist and link them from the footer so `sameAs` has a real target. Re-check
the Pages/Coverage reports after the first crawl cycle.
