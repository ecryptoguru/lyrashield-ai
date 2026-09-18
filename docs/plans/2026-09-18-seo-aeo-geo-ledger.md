# SEO / AEO / GEO Megaplan — Execution Ledger

Progress tracker for [`2026-09-18-seo-aeo-geo-megaplan.md`](./2026-09-18-seo-aeo-geo-megaplan.md).
Read this first in any session; update it last. Commit early and often.

Base: `origin/main` = `171e225d`. Worktree: `.worktrees/seo-aeo-geo`, branch `devin/seo-aeo-geo`,
pushed as **PR #702** — created from `origin/main` so the dirty `feat/myra-support-agent` tree and its
user-owned deletions stay untouched.

**Delivered as one PR, not four.** The waves are inherently stacked (waves 2–4 modify files wave 1
creates), so separate PRs would have meant stacked branches and four CI runs over near-identical
code. The six commits keep per-wave rollback granularity.

## Status

| Wave | Scope                                                  | Status                 | PR  | Notes                                         |
| ---- | ------------------------------------------------------ | ---------------------- | --- | --------------------------------------------- |
| 1    | Gate + crawler eligibility + machine-readable surfaces | ✅ complete 2026-09-18 | —   | Gate landed first so waves 2–4 are enforced   |
| 2    | Entity + structured data                               | ✅ complete 2026-09-18 | —   | Breadcrumb rule found 4 extra pages           |
| 3    | Metadata limits + OG cards + `/research`               | ✅ complete 2026-09-18 | —   | **Baseline drained to zero**                  |
| 4    | Internal linking + thin pages                          | ✅ complete 2026-09-18 | —   | Gate is already strict; no baseline work left |

| Wave | Commits         | Local verify | CI  | Merged |
| ---- | --------------- | ------------ | --- | ------ |
| 1    | `983c146f`      | PASS         | —   | —      |
| 2    | `72742681`      | PASS         | —   | —      |
| 3    | `d3e6a1ce`      | PASS         | —   | —      |
| 4    | see session log | PASS         | —   | —      |

## Baseline allowlist

`apps/marketing/scripts/seo-baseline.json` is **empty** as of the Wave 3 close-out: 241 pages, 0
baselined, 0 stale, 0 new violations. Its `notes` block documents what each rule means so a future
entry is easy to judge; every rule is now enforced strictly.

Drain history: 184 entries at the Wave 1 gate launch → 177 after Wave 2 → 5 after the Wave 3 copy
pass → 0.

## Founder decisions required

1. Verified profile URLs for `Organization.sameAs` (GitHub org, LinkedIn company page, X handle).
   `contactPoint` and the raster logo now ship; `sameAs` stays absent rather than invented.
2. `foundingDate` / `legalName` / registered address, if publishable.
3. Named human author for blog posts vs strengthening the Organization author. The Organization
   author is unchanged; no Person was attributed speculatively.
4. Google/Bing verification codes — set `PUBLIC_GOOGLE_SITE_VERIFICATION` /
   `PUBLIC_BING_SITE_VERIFICATION` in `wrangler.jsonc` and the tag renders. IndexNow already ships
   with a generated key (`public/a74cf3dd89f266a1c0b8d92a06c50f2b.txt`); rotate by replacing that file
   and `INDEXNOW_KEY` in `scripts/indexnow.mjs` together.
5. Whether and when to publish anonymized scan statistics on `/research`. The page now states
   plainly that it reports no results yet.

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
- `/api/waitlist/position?code=INVALID` returns 500 locally (D1 state), not 404 as in production. The
  browser suite does not cover it; the CI smoke check asserts it against production.

## Session log

- 2026-09-18 — Plan written from a read-only production crawl of all 241 sitemap URLs plus source
  review. Worktree created from `origin/main`.
- 2026-09-18 (session 2) — Wave 1 implemented and verified locally (`983c146f`).
  - **Gate**: `scripts/crawl-built-site.mjs` (+ `seo-baseline.json`, `tests-browser/seo.e2e.ts`,
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
- 2026-09-18 (session 3) — Wave 2 implemented and verified (`72742681`).
  - `Organization.logo` is now an `ImageObject` over `/logo.png` (1024x1024) instead of the SVG;
    `contactPoint` covers support and security reporting with the mailboxes already published on
    `/support`, `/privacy` and `/security-reporting`.
  - `/pricing`, `/demo`, `/support` and `/security-reporting` emit `WebPage` + `BreadcrumbList`.
  - New gate rule `jsonld-breadcrumb-missing` (every non-root page) found four more pages missing the
    trail: `/agents` and the Aider, Pi and Devin guides. All four fixed.
  - Baseline 184 → 177. Verify: 213 vitest tests, typecheck, lint, `test:browser` 41 passed.
- 2026-09-18 (session 4) — Wave 3 implemented and verified; **the baseline is empty**.
  - **OG cards**: `scripts/generate-og-cards.mjs` renders 15 section cards at exactly 1200x630 in
    Chromium using the DESIGN.md tokens and the bundled fonts; `src/lib/og-images.ts` maps every
    built route to a card, and `Base.astro` uses the map when a page passes no `ogImage`.
    `/og/og-default.png` remains only for routes outside the sitemap.
  - **Titles**: blog suffix `" | LyraShield AI Blog"` → `" | LyraShield AI"` (161 posts), then the
    26 posts still over 65 rendered characters rewritten; 10 docs titles trimmed to ≤ 62; the tag-hub
    title template trimmed. No duplicate titles.
  - **Descriptions**: 20 docs guides, `/pricing`, `/vibe-security-50` and the six tag hubs trimmed to
    ≤ 160 characters. Two single-quoted docs descriptions (`cline`, `vscode`) were missed by the
    first pass and caught by the gate.
  - **`/research`**: title/description/lede now describe what the page is (planned research, sample
    protection, how to cite) and state plainly that no results are reported yet.
  - **FAQ dedupe**: the repeated question in `claude-code-security-workflow.mdx` is now distinct, and
    `blog-validation-lib.mjs` rejects duplicate FAQ questions (with a unit test) because a repeat
    emits two FAQPage entries with one name.
  - Baseline 177 → 0. Verify: 217 vitest tests, typecheck, lint, `build`, all six validators,
    `seo:crawl` (241 pages, 0/0/0), `crawl-built-blog` (161 / 6 / 235), `test:browser` 41 passed.

- 2026-09-18 (session 5) — Wave 4 implemented and verified.
  - **Internal linking**: `BlogCta.astro` gains a "Next steps" nav (Pricing, For coding agents,
    Methodology, Free Lite Check), so all 161 posts now link to the money pages that previously
    received **zero** links from the library. `/demo` joins the footer Product column and the desktop
    Resources menu (not the mobile menu — its height budget is asserted by `theme.e2e.ts`), and the
    `/blog` hub now links its editorial policy.
  - **Thin pages**, bounded to facts already published elsewhere: `/support` gains a "Where to look
    first" list linking the troubleshooting, REST API, approvals and methodology pages;
    `/security-reporting` documents the `/.well-known/security.txt` route it is the policy for and
    what is in scope; `/demo` states the booking constraints that `MYRA_COPY`/`MYRA_LIMITS` already
    publish (30 minutes, 14-day horizon, host timezone, code-verified email, who you talk to).
    Word counts: `/support` 292→395, `/security-reporting` 308→403, `/demo` 366→442.
  - Verify: 217 vitest tests, typecheck, lint, `build`, all six validators, `seo:crawl` (241 pages,
    0/0/0), `crawl-built-blog` (161 / 6 / 235), `test:browser` 41 passed.

- 2026-09-18 (session 6) — Hardening pass: three more gate rules, one real gap fixed, one script
  bug fixed, and the whole surface re-verified.
  - **Gate grew three rules**: `img-alt-missing` (every `<img>` needs an explicit `alt`, decorative
    ones included), `html-lang-missing`, and `sitemap-lastmod-missing`. All three pass on the
    current build, and each is exercised by a unit test.
  - **`/demo` had no `lastmod`** — it was the only sitemap URL missing one, because it was never
    registered in `astro.config.mjs`'s static-page list. Fixed, and the new rule now catches the same
    drift for any future page. All 241 URLs carry a real git date.
  - **`scripts/indexnow.mjs` bug**: it filtered sitemap URLs by the _origin it fetched_, so a local
    dry run always reported "no same-host URLs" and submitted nothing — and a sitemap served from a
    different host than the key file would have silently no-op'd in production too. The submitted
    host and `keyLocation` now come from the sitemap, child sitemaps are fetched through the origin
    under test, and the key file is verified before anything is claimed. Dry run against the local
    preview: `241 URL(s) on lyrashieldai.com would be submitted.`
  - **Footer** links the public GitHub repository with `rel="me"` — a real URL, already cited in
    `llms.txt`. `Organization.sameAs` stays empty: there is still no verified _product_ profile.
  - **Gate proven to fail, not just pass**: injecting four regressions into the built
    `pricing/index.html` (missing description, `img` without `alt`, stripped `lang`, wrong canonical)
    produced exactly those four violations and exit code 1. Restored and re-verified green.
  - **Performance verified rather than assumed**: on a throttled Slow-4G + 4× CPU profile the
    homepage FCP 1320 ms / LCP 1392 ms / CLS 0.0155 / 368 KB; `/pricing` LCP 752 ms; `/agents`
    1164 ms. The hero downloads its 26 KB AVIF (not the 93 KB JPEG), so the missing responsive
    `srcset` (SF-27) is a verified non-issue and the deliberately-eager product screenshots are not
    competing with the LCP element. No change made; recorded instead.
  - **Machine-readable surfaces validated**: `rss.xml` parses with 20 items, no trailing-slash links,
    `lastBuildDate` present, every item has `pubDate` and `guid`; `.well-known/security.txt` satisfies
    RFC 9116 (Contact + Expires 364 days out + Canonical + Policy); `sitemap-0.xml` parses with 241
    URLs, 241 `lastmod`, 161 image entries, no duplicates, no `http://`, no noindex pages;
    `robots.txt` parses into 3 groups (wildcard, 19 retrieval agents, 4 training agents), all
    allow-all.
  - **Full repository suite**: `pnpm test` → core 4422 passed / 3 failed, marketing all passed,
    motion 18 passed, ops passed. The 3 failures are `packages/config/src/env-runtime.test.ts`, which
    passes 11/11 with the local `.env` absent: this machine's `.env` sets `MYRA_WRITES_ENABLED=1`
    without the Google calendar credentials production validation then demands. Not related to this
    branch, and CI has no `.env`. Four earlier file-load failures were a missing `@lyrashield/mcp`
    build in this fresh worktree, fixed by `pnpm --filter @lyrashield/mcp build`.
  - **Environment note for the next session**: a fresh worktree needs `.env` (root), `apps/web/.env`,
    `pnpm --filter @lyrashield/db exec prisma generate`, `pnpm --filter @lyrashield/sdk build` and
    `pnpm --filter @lyrashield/mcp build` before the core suite is meaningful. Without them the suite
    reports 100+ phantom failures.

- 2026-09-18 (session 7) — PR #702 opened and CI brought to green.
  - **The secret scan failed, twice, for a real reason.** gitleaks reported
    `generic-api-key` on `export const INDEXNOW_KEY = "..."` in
    `scripts/indexnow.mjs`. The key is public by design (IndexNow fetches it from
    `https://<host>/<key>.txt`), but a 32-hex literal is indistinguishable from a leaked credential to
    a scanner.
  - **First fix — remove the literal, not the control.** `indexnow.mjs` now resolves the key from the
    single file the protocol serves (exactly one `public/<32 hex>.txt` whose content is its own
    filename stem, or it fails loudly). One source of truth, no secret-shaped literal in source, and
    the unit test asserts the literal is gone. Re-running the scan still failed, because gitleaks
    walks the PR's whole commit range and the original commit is inside it.
  - **Second fix — escalated, then applied on approval.** The remaining finding needed either a
    `.gitleaksignore` fingerprint or a history rewrite plus force-push. Both touch something the
    instructions say to escalate rather than decide unilaterally, so the choice was put to the user;
    they chose the fingerprint. The entry is scoped to one
    `commit:file:rule:line` with a comment explaining why, matching the repo's existing reviewed
    entries for the Myra sanitizer fixtures. No rule, path or regex allowlist was widened.
  - **Final CI on `34ea350d`: all green.** Lint/Typecheck/Test & Build 4m14s (this job runs
    `test:browser`, so the new SEO gate now executes on every marketing change), both secret-scan
    jobs, worker contract, changed-path detection and the LyraShield GitHub Action.

- 2026-09-18 (session 8) — Review findings fixed, the concurrent-session conflict resolved, and the
  contact address moved to `admin@`.
  - **All nine CodeRabbit findings on #702 fixed** (`ce037464`). One was a real bug in the gate:
    `sitemapEntries()` was being fed the sitemap _index_, which carries `<sitemap>` blocks rather
    than `<url>` blocks, so the `sitemap-lastmod-missing` rule found nothing and had never fired.
    Entries are now collected while walking the child sitemap(s), with a `sitemap-entries-missing`
    rule for the empty case. **Proved live**: removing `/demo`'s lastmod from the built sitemap now
    yields `sitemap-lastmod-missing: /demo` and exit 1. Also fixed: an unreachable `robots.txt`
    skipped the whole agent check (`robots-missing` now reports it), IndexNow reported every
    response as accepted (only 200/202 are), `Base.astro` hardcoded both contact emails while the
    pages honour env overrides, and four copy findings (approvals scope, amp "Agent Skill",
    research "plans to publish", vibe-security-50 "operational or human evidence") plus the README's
    inaccurate Lighthouse "requires" wording.
  - **Concurrent-session conflict caught and instrumented** (`05dce911`). While working, another
    session on `feat/myra-support-agent` began switching `/security-reporting` from `security@` to
    `support@`. `/.well-known/security.txt` is a static file and cannot follow
    `PUBLIC_SECURITY_EMAIL`, so it would have gone stale silently — advertising an address the page
    no longer publishes. The gate now requires the security.txt `Contact` to be published on
    `/security-reporting`; **proved live** by making the built reporting page publish `support@`
    while the file still said `security@` → `security-txt-contact-mismatch`, exit 1.
  - **Contact address moved to `admin@lyrashieldai.com`** (`f3157941`) on request, replacing
    `abuse@` in `wrangler.jsonc` (the deployed Worker var) and in `/about`'s fallback. `/terms`
    renders it as the abuse contact, `/about` for partnership and product questions. The
    `PUBLIC_ABUSE_EMAIL` variable name is unchanged: renaming it would touch `turbo.json`,
    `.env.example`, `astro.config.mjs` and the terms page for no functional gain.
  - **Mailbox reality check**: `dig MX lyrashieldai.com` → `smtp.google.com`, so domain mail is on
    **Google Workspace**, not Cloudflare Email Routing. `admin@`, `support@`, `security@`, `sales@`
    and `marketing@` are all aliases on one mailbox, so no address published on the site points at an
    unread inbox — including the `security@` in `security.txt`. The only Cloudflare-side change the
    address needs is the `wrangler.jsonc` var, which the `deploy-marketing` job applies on merge to
    main; there are no other Cloudflare references to the old address.
  - **Unused aliases**: `sales@` and `marketing@` are live but not wired to anything. `/demo` has no
    contact address and `/about` sends partnerships to `admin@`. Left as-is rather than guessed at.
  - Verify: gate (241 pages, 0/0/0), lint, typecheck, 217 unit tests, build, all six validators,
    blog crawl (161 / 6 / 235), `test:browser` 41 passed, prettier.
