# SEO / AEO / GEO Megaplan — Execution Ledger

Progress tracker for [`2026-09-18-seo-aeo-geo-megaplan.md`](./2026-09-18-seo-aeo-geo-megaplan.md).
Read this first in any session; update it last. Commit early and often.

Base: `origin/main` = `171e225d`. Worktree: `.worktrees/seo-aeo-geo` (branch `devin/seo-aeo-geo`),
created from `origin/main` so the dirty `feat/myra-support-agent` tree and its user-owned deletions
stay untouched.

## Status

| Wave | Scope | Status | PR | Notes |
| --- | --- | --- | --- | --- |
| 1 | Gate + crawler eligibility + machine-readable surfaces | ✅ complete 2026-09-18 | — | Gate landed first so waves 2–4 are enforced |
| 2 | Entity + structured data | ⬜ not started | — | `sameAs` blocked on founder decision 1 |
| 3 | Metadata limits + OG cards + `/research` | ⬜ not started | — | Drains most baseline entries |
| 4 | Internal linking + thin pages + strict gate | ⬜ not started | — | Empties `seo-baseline.json` |

| Wave | Commits | Local verify | CI | Merged |
| --- | --- | --- | --- | --- |
| 1 | see session log | PASS | — | — |
| 2 | — | — | — | — |
| 3 | — | — | — | — |
| 4 | — | — | — | — |

## Baseline allowlist

`apps/marketing/scripts/seo-baseline.json` holds the violations measured on 2026-09-18 and must be
empty when Wave 4 lands. Each entry names the wave that removes it; the file's `notes` block carries
the same mapping for reviewers.

| Rule | Count at Wave 1 close | Removed by |
| --- | --- | --- |
| `title-too-long` | 68 (57 blog posts, 10 docs guides, 1 tag hub) | Wave 3 |
| `description-too-long` | 29 (20 docs, 6 tag hubs, `/pricing`, `/research`, `/vibe-security-50`) | Wave 3 |
| `og-image-default` | 80 (every non-blog-post page) | Wave 3 |
| `jsonld-page-entity-missing` | 3 (`/demo`, `/support`, `/security-reporting`) | Wave 2 |

Wave 1 drained `robots-agent-missing`, `llms-url-missing`, `rss-trailing-slash` and
`security-txt-missing` from the initial 184-entry baseline.

## Founder decisions required

1. Verified profile URLs for `Organization.sameAs` (GitHub org, LinkedIn company page, X handle).
2. `foundingDate` / `legalName` / registered address, if publishable.
3. Named human author for blog posts vs strengthening the Organization author.
4. Google/Bing verification codes — set `PUBLIC_GOOGLE_SITE_VERIFICATION` /
   `PUBLIC_BING_SITE_VERIFICATION` in `wrangler.jsonc` and the tag renders. IndexNow already ships
   with a generated key (`public/a74cf3dd89f266a1c0b8d92a06c50f2b.txt`); rotate by replacing that file
   and `INDEXNOW_KEY` in `scripts/indexnow.mjs` together.
5. Whether and when to publish anonymized scan statistics on `/research`.

## Do not touch

- The main checkout's user-owned deletions (`docs/plans/2026-09-12-*`, `docs/plans/2026-09-13-*`,
  `docs/review-plan-2026-09-14.md`) and its untracked files.
- The sibling `2026-09-18-ui-ux-audit-*` plan and ledger (owned by the UI/UX audit wave).
- `docs/plans/megaplan-execution-ledger.md` (owned by the code-simplification megaplan).

## Worktree env gotchas

- Marketing-only work: leave `apps/marketing/.env` and `.dev.vars` absent so the build falls back to
  `wrangler.jsonc` (indexable, `PUBLIC_SITE_URL=https://lyrashieldai.com`) exactly as CI does. A
  local `.env` with `PUBLIC_INDEXABLE=false` builds a noindex preview the SEO gate cannot assert on.
- Root `vitest` excludes `apps/marketing/src/tests/**`; run marketing tests through the package filter.
- `pnpm preview` sets `LYRASHIELD_LOCAL_PREVIEW=1` for its own build. Without it the middleware
  http→https upgrade fires locally (wrangler dev rewrites the request host to the custom domain) and
  301s every SSR route, so `llms.txt`, `rss.xml`, `agents.md` and `/api/*` are unreadable locally.

## Session log

- 2026-09-18 — Plan written from a read-only production crawl of all 241 sitemap URLs plus source
  review. Worktree created from `origin/main`.
- 2026-09-18 (session 2) — Wave 1 implemented and verified locally.
  - **Gate**: new `scripts/crawl-built-site.mjs` (+ `seo-baseline.json`, `tests-browser/seo.e2e.ts`,
    `seo:crawl` / `seo:baseline` scripts, `src/tests/site-seo-gate.test.ts`). `inspectHtml` in
    `crawl-built-blog.mjs` gained `ogImage*` and `jsonLdTypes` additively.
  - **Root-cause fix found by the gate**: the middleware's http→https upgrade tested
    `url.hostname`, which `wrangler dev` rewrites to the custom domain, so every SSR route 301'd to
    `https://127.0.0.1:8787` locally. `pnpm preview` now sets `LYRASHIELD_LOCAL_PREVIEW=1` and the
    middleware stands down that (redundant) layer; the worker-entry scheme guard still enforces
    plaintext→https in production.
  - **Surfaces**: `robots.txt` names 19 retrieval agents plus the 4 training crawlers with a policy
    comment; `/.well-known/security.txt` added; `llms.txt` derives compare and tag links from
    collections and gains `/webmcp`, `/webmcp-controls.json`, `/demo` and a "How to cite" block;
    RSS is slash-less with a content-derived `lastBuildDate`; `/blog/1` 301s to `/blog`; the sitemap
    carries `<image:image>` entries for all 161 blog heroes; verification meta tags are env-gated;
    `scripts/indexnow.mjs` + key file + non-fatal CI step; Lighthouse now covers five pages.
  - **Not achievable as planned**: the sitemap homepage `<loc>` cannot carry a trailing slash —
    `@astrojs/sitemap` rewrites it whenever `trailingSlash: "never"`. Recorded in `astro.config.mjs`;
    the two forms are the same URL to a crawler, so SF-07 is closed as a non-issue.
  - **Verify**: lint, typecheck (0 errors), 212 vitest tests, `build`, all six blog/compare/redirect
    validators, `seo:crawl` (241 pages, 0 new, 0 stale), `crawl-built-blog` (161 articles / 6 tag
    archives / 235 images), `test:browser` (41 passed, including both new SEO specs). Prettier clean.
