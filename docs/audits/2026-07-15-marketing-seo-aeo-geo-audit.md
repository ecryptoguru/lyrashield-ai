# LyraShield AI marketing SEO, AEO, and GEO audit

Date: 2026-07-15; production verification updated 2026-07-16
Scope: `apps/marketing` public routes, rendered metadata, crawl controls, structured data, information architecture, on-page content, internal links, and browser-local tool landing pages.

## Executive result

The marketing site is now live and indexable at `https://lyrashieldai.com`: server-rendered HTML, self-referencing apex canonicals, a path/query-preserving `www` 301, crawlable robots and sitemap responses, an AEO/GEO `llms.txt`, accessible headings, honest product claims, and structured data that matches visible content. The unavailable network scanner and legal terms remain individually `noindex` and are excluded from the sitemap.

This audit found and remediated the main code-level gaps:

- Replaced short, generic tool metadata with unique intent-specific titles and 120–160 character descriptions.
- Added answer-first, tool-specific summaries plus explicit checks, limitations, privacy boundaries, and primary references to all five free-tool pages.
- Fixed the methodology page's nested `<main>` landmark and added visible and structured breadcrumbs.
- Added explicit production robots preview directives while retaining the fail-closed pre-launch `noindex, nofollow` gate.
- Added a per-page `noindex` control for the 404 page and turned the empty blog index into a useful resource hub rather than an indexable dead end.
- Strengthened Organization, WebSite, WebApplication, WebPage, ItemList, and breadcrumb entity relationships without adding unsupported “AI SEO” schema.
- Added an answer-first definition of release assurance and a concise result-interpretation section.
- Improved internal linking among the homepage, methodology, tools index, individual tools, and footer.
- Added regression tests for metadata uniqueness and length, robots directives, semantic landmarks, visible structured-data counterparts, and tool-page completeness.
- Fixed a production-only canonical defect in which the JSONC reader rejected Wrangler's trailing commas and silently fell back to localhost. The parser now has regression coverage, and the live canonical, Open Graph URL/image, JSON-LD IDs, and sitemap all use the apex origin.
- Added defensive Cloudflare response headers while allowing the injected Cloudflare analytics beacon, eliminating live CSP console errors.
- Added schema and review metadata to the sample report, terms, and methodology; added explicit evidence-state definitions and citation boundaries to `llms.txt`.
- Decoupled marketing indexability from the unavailable scanner: the ready public surface is crawlable now, while scanner enablement still fails closed unless the app origin, Turnstile, and monitored abuse mailbox are configured together.

No ranking or AI-citation outcome is claimed. Cloudflare deployment, domain/canonical attachment, technical indexability, live crawl validation, and synthetic Lighthouse are proven. Search Console/Bing ownership, sitemap submission in those accounts, actual crawl discovery, backlinks, and real-user Core Web Vitals remain operational growth measurements.

## Audited route inventory

| Route                              | Primary intent                             | Indexing state                  | Main optimization                                                                    |
| ---------------------------------- | ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| `/`                                | AI-built app release assurance             | Indexable                       | Answer-first definition, entity identity, evidence-methodology link                  |
| `/methodology`                     | Security evidence and coverage methodology | Indexable                       | One main landmark, WebPage + breadcrumb data, reviewed date, interpretation guidance |
| `/sample-report`                   | Example security assurance report          | Indexable                       | Sanitized-example boundary, WebPage, breadcrumb, evidence-state language             |
| `/tools`                           | Free security tools for AI-built apps      | Indexable                       | Intent-specific description, ItemList, privacy/process answers, internal links       |
| `/tools/ai-app-security-checklist` | AI app security checklist                  | Indexable                       | Specific checks/limits, OWASP ASVS reference                                         |
| `/tools/security-headers-checker`  | Security headers and CORS checker          | Indexable                       | Specific checks/limits, MDN CSP and CORS references                                  |
| `/tools/secret-exposure-scanner`   | Local secret exposure scanner              | Indexable                       | Specific file/pattern limits, OWASP secrets reference                                |
| `/tools/supabase-rls-checker`      | Supabase RLS policy checker                | Indexable                       | Static-analysis boundary, Supabase RLS reference                                     |
| `/tools/jwt-session-inspector`     | JWT and cookie session inspection          | Indexable                       | Signature-verification boundary, RFC 7519 and MDN references                         |
| `/blog`                            | AI app security resources                  | Indexable                       | Useful methodology/tool paths while articles remain in editorial review              |
| `/scan`                            | Passive public security check              | `noindex`; omitted from sitemap | Disabled fail-closed until app API, Turnstile, and abuse contact are configured      |
| `/terms`                           | Acceptable use and abuse reporting         | `noindex`; omitted from sitemap | Visible authorization/privacy limits; monitored contact remains scanner gate         |
| `/404`                             | Error recovery                             | Always `noindex`                | Explicit noindex directive                                                           |

Draft blog posts and tag routes were inspected but were not published or added to the production index. Publishing remains an editorial approval step.

## Findings and disposition

### P0 — release blockers

| Finding                                                     | Disposition                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Preview builds must not leak into search                    | Retained: preview builds can use global `noindex`, robots disallow, and 404 `llms.txt`                 |
| Canonical/sitemap origin drifted to localhost in production | Fixed JSONC parsing, tested the Wrangler origin, rebuilt, redeployed, and verified live                |
| Production indexing without a public HTTPS origin           | Blocked by the build; production is attached to the verified HTTPS apex                                |
| Unavailable scanner accidentally becoming indexable         | Prevented with page-scoped `noindex`, sitemap exclusion, disabled controls, and no fallback app origin |

No open P0 code defect remains in the audited surface.

### P1 — high-impact discoverability and answer quality

| Finding                                                        | Before                                               | Remediation                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Individual tool descriptions were 63–85 characters and generic | Weak differentiation and snippet context             | Unique 120–160 character descriptions aligned to each tool's search intent                                    |
| Tool pages reused generic checks and limitations               | Thin answer extraction and low trust specificity     | Tool-specific answer, checks, limitations, privacy, and primary references                                    |
| Methodology emitted nested main landmarks                      | Invalid page hierarchy for assistive navigation      | Replaced inner `<main>` with a section; one page-level main remains                                           |
| Tool breadcrumbs omitted Home and were not visible             | Incomplete hierarchy                                 | Visible Home → Tools → Tool breadcrumbs mirrored in JSON-LD                                                   |
| Methodology had no page/breadcrumb structured data             | Weaker entity and hierarchy signals                  | Added visible breadcrumbs plus WebPage and BreadcrumbList data                                                |
| Crawl previews relied on defaults                              | Correct but implicit                                 | Added explicit full-preview directives to indexable pages                                                     |
| Homepage did not directly define its category                  | Product loop was clear, category answer was implicit | Added a concise “What is release assurance?” answer and FAQ entry                                             |
| Empty blog was an indexable dead end                           | No published posts                                   | Reframed as a useful resource hub linking the evidence methodology and five free tools; drafts remain private |

All identified P1 code changes are implemented.

### P2 — launch and growth opportunities

These are not code defects and should not be represented as complete before the real domain is live:

1. Verify the apex and `www` redirect in Google Search Console and Bing Webmaster Tools, then submit `https://lyrashieldai.com/sitemap-index.xml` in those accounts.
2. Validate representative pages in Google's Rich Results Test and Schema Markup Validator using the deployed HTML; local and live JSON parsing already passes.
3. Monitor Search Console performance, IndexNow/Crawler Hints if enabled, AI Crawl Control, and real-user Core Web Vitals after discovery; establish baselines before promising outcomes.
4. Publish only founder-approved, expert-led research. Prioritize original evidence-state, coverage, and retest analysis over commodity keyword pages.
5. Create page-specific social/illustrative images when there is real visual material to add; do not manufacture generic diagrams solely for ranking.
6. Consider Cloudflare Crawler Hints/IndexNow once the publishing cadence justifies proactive update notifications.

## AEO/GEO approach used

The implementation treats AEO and GEO as high-quality search optimization, not as a separate collection of hacks:

- Important answers are present in initial HTML, not hidden behind a client fetch.
- Each page has one intent, one H1, a direct opening answer, and descriptive H2 sections.
- Claims state scope and limitations; confidence is not presented as proof.
- Primary standards and vendor documentation are linked where they help a user investigate a result.
- Structured data describes visible content and supported entities only.
- Internal links connect definitions, tools, methodology, and conversion paths.
- `llms.txt` remains an optional copy-safe summary for other systems; it is not treated as a Google ranking requirement.
- No doorway pages, keyword variants, synthetic customer proof, pricing, benchmarks, or unsupported security guarantees were added.

## Validation requirements

Code and local render validation:

```bash
pnpm --filter @lyrashield/marketing lint
pnpm --filter @lyrashield/marketing typecheck
pnpm test -- apps/marketing/src/tests
PUBLIC_SITE_URL=https://example.com \
PUBLIC_INDEXABLE=true \
pnpm --filter @lyrashield/marketing build
git diff --check
```

Rendered route checks must confirm:

- exactly one H1 and one main landmark per HTML page;
- a unique title, description, and canonical on every indexable candidate;
- production robots directives and pre-launch noindex behavior;
- valid JSON-LD JSON with visible equivalents;
- no unexpected 4xx internal links;
- functional tools, focus states, and readable desktop/mobile layouts.

## Production verification result

Completed on the real deployed surface:

- apex HTTPS and the path/query-preserving `www` 301;
- production build with `PUBLIC_INDEXABLE=true` and page-scoped noindex controls;
- crawlable robots, 10-URL sitemap, and 200 `llms.txt` responses;
- 10 sitemap pages and 19 internal URLs crawled with zero broken links;
- valid JSON-LD JSON, one H1, unique canonicals, and no localhost metadata on every sitemap page;
- homepage Lighthouse 97/100/100/100 and methodology/tools 99/100/100/100 for performance/accessibility/best-practices/SEO, with zero console errors;
- Docker reproduction of the generated static marketing artifact;
- full repository gate: lint, typecheck, 818 tests in 85 files, production build, formatting, and `git diff --check`.

Still operational rather than code-complete:

- Google Search Console/Bing ownership and sitemap submission;
- real-user Core Web Vitals, impressions, rankings, backlinks, and AI citations;
- scanner app-origin deployment, Turnstile, monitored abuse mailbox, and the scanner's separate production QA;
- external social and AI-platform cache/unfurl validation.
