# Public pages — local implementation and review

Date: 2026-10-28. Branch: `codex/premium-landing-local-review`.

Local implementation is complete for the actionable findings in the
[public-pages review](public-pages-and-blog-review-2026-10-28.md). Existing homepage
work and unrelated local files were preserved. No commit, push, merge, media
publication or deployment was performed. **Localhost approval remains the release
gate.** Preview: <http://localhost:8787/>.

## Changes

- Blog cards put titles, summaries and actions before artwork; the featured story
  uses a desktop split layout. Article answers and contents precede decorative
  artwork, with a smaller headline scale and a 72ch body measure.
- A shared formatter keeps publication dates consistent. Read links include their
  visible wording in accessible names. Contextual article actions precede an
  optional, collapsed product-updates form; optional context fields are disclosed.
- Six primary browsing topics are derived from existing editorial image clusters
  and validated against each article's existing tags. Secondary tags remain intact.
  Counts are 2 builder-workflow, 22 access-control, 32 web-security, 6 supply-chain,
  63 agent-security and 35 verification guides: 160 total. This is presentation
  classification, not a claim that every article received a new editorial review.
- Category browsing is bounded to 20 guides with real pagination links; search
  covers the full category. Article archives have distinct canonical URLs and
  indexability. Sitemap, collection dates and `llms.txt` include the archive pages.
  The crawler checks primary membership separately from related-topic links.
- Approved catalog artwork gains 480/960px AVIF/WebP candidates, generated into
  `dist` in production and preview builds. The original 1600px renditions remain.
  A build-only Sharp dependency uses the version already in the workspace.
- Docs use compact native navigation groups, a bounded mobile navigation region,
  visible current-guide context and a close action. Filtering explicitly searches
  guide/client names. Copy success is announced; blocked clipboard access selects
  the code and explains manual recovery. Prose and long callouts wrap at 200% text.
- Local checks enable controls after initialization and explain script availability
  in server-rendered HTML. Secret-file review rejects over 20 selections before
  reading, filters unsupported/binary inputs, handles read errors and reports exact
  selected/scanned/skipped coverage. Matches remain redacted and input stays local.
- Pricing defines units, rounding and multipliers beside the choice. The Local
  button displays its launch status. Shared prices, entitlements and billing logic
  are unchanged.
- Methodology removes the duplicated introductory summary and brings the existing
  captured record forward. Evidence Vault adds a clearly labeled illustrative
  record. Comparisons gain collapsible section links and workflow decision context.
  Demo fallback exposes selectable contact details, copy feedback and a useful
  email template. Research status uses a neutral treatment. Long policies gain
  native contents navigation without changing legal text or review dates.
- The shared header uses a text-relative container query to reflow at enlarged
  text sizes while retaining 44 CSS-pixel icon controls. Existing themes, native
  scrolling, reduced-motion handling and cinema controller remain intact.

The [surface brief](../design/public-reading-and-tools.md) records the presentation
and motion constraints. Existing authorship is retained: individual attribution
was not invented. Competitor facts, legal validity and all article claims were not
represented as newly verified.

## Verification

| Check                              | Result                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| Marketing Vitest                   | 626 tests passed, 65 files                                      |
| Motion contracts                   | 30 tests passed                                                 |
| Responsive-image pipeline test     | Passed; verifies AVIF/WebP dimensions                           |
| Blog image validation              | Passed for every approved image batch                           |
| Blog content validation            | Passed, including 17 PHP2Shell checks                           |
| Marketing ESLint                   | Passed with zero warnings                                       |
| Astro typecheck                    | Zero errors/warnings; two pre-existing hints                    |
| E2E TypeScript                     | Passed, including marketing browser specs                       |
| Repository tracked-file formatting | Passed                                                          |
| `git diff --check`                 | Passed                                                          |
| Production build                   | Passed, including responsive images, HTTPS guard and CSP        |
| Local-preview build                | Passed through its own build/guard/CSP workflow                 |
| Chromium/touch browser projects    | 70 passed; 21 intentionally skipped duplicate matrix cases      |
| WebKit desktop/phone projects      | 36 passed; 20 intentionally skipped duplicate matrix cases      |
| Focused visual captures            | 2 additional passing executions                                 |
| Built-site SEO crawl               | 283 sitemap pages, zero violations/baselines/stale entries      |
| Built-blog crawl                   | 160 articles, 12 category archive pages, 496 image URLs; passed |

The responsive-layout matrix visits 20 representative routes at 360, 390, 768,
1280 and 1440px in both themes with Chromium. WebKit repeats the matrix at 390 and
1280px. Focused checks cover navigation, clipboard success/failure, file caps,
partial results, no-JavaScript tools, category pagination, dates, policy anchors,
reduced motion and 200% text enlargement on the blog, docs, pricing and SQL tool.
The homepage content/height budget, static fallback, media ranges and theme/menu
regressions also pass. This is representative template acceptance, not manual
reading of every article or execution of all client integrations.

Browser testing caught and resolved enlarged-text overflow in the introductory
blog links, shared header and a docs callout. A temporary test-server startup race
was corrected by waiting for the explicitly started preview before running the
suite. Final browser runs reused the completed build. Previously reviewed cinema
bytes were restored after building; no published media was overwritten.

## Local performance samples

Lighthouse 13.6, bundled Chromium, mobile form factor, simulated throttling:
150ms RTT, 1638.4Kbit/s throughput and 4× CPU slowdown. Samples are local lab
measurements, not field Core Web Vitals or a controlled before/after experiment.

| Page                | Performance | Accessibility | Best practices | SEO |  LCP |   CLS |
| ------------------- | ----------: | ------------: | -------------: | --: | ---: | ----: |
| Homepage            |          97 |           100 |             96 | 100 | 2.3s |     0 |
| Blog                |          96 |           100 |             96 | 100 | 2.4s |     0 |
| PHP-version article |          96 |           100 |             96 | 100 | 2.3s | 0.020 |
| Pricing             |          97 |           100 |             96 | 100 | 2.1s | 0.059 |

All four samples meet LCP ≤2.5s and CLS ≤0.1. The blog's previously flagged
label-in-name audit now passes independently of the aggregate accessibility score.
Best-practices deductions include the known local-preview CORS behavior against
production account-preference/Myra reads; production CORS was not broadened.
Lighthouse scores do not establish comprehensive accessibility compliance.

The homepage's separate, earlier actual-film performance evidence and its recorded
limits remain in [the homepage review](premium-homepage-local-review-2026-10-28.md).
The cinema controller was not changed by this pass. The earlier homepage LCP
sample was 2.58s; the fresh sample above is 2.3s. Both are retained as observations,
not a guarantee of repeated lab or production field results.

## Review links and evidence

- [Blog](http://localhost:8787/blog)
- [Article](http://localhost:8787/blog/check-php-version-php2shell)
- [Docs](http://localhost:8787/docs/integrations/openai-codex)
- [Secret-file tool](http://localhost:8787/tools/secret-exposure-scanner)
- [Pricing](http://localhost:8787/pricing)
- [Methodology](http://localhost:8787/methodology)
- [Demo fallback](http://localhost:8787/demo)

Generated evidence: `output/playwright/public-pages-after/`, including featured-story
captures, mobile/desktop theme views and the four Lighthouse JSON receipts.
Before views remain in `output/playwright/site-review-2026-10-28/assessment-a/`.
These artifacts and generated media remain outside source control.

During review, check reading order, both themes, menu expansion, docs filtering and
copy feedback, category navigation, tool selection limits, pricing definitions and
contact recovery. The preview remains running. Physical devices, real assistive
technology, Firefox, production field performance, native WebKit clipboard behavior,
live booking and authenticated/provider workflows remain unverified. WebKit copy
success uses a controlled clipboard double; Chromium exercises granted clipboard
access. No paid scans, bookings, emails or account/billing mutations were performed.
