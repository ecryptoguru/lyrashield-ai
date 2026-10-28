# Public landing pages and blog review — 2026-10-28

Method: dual-agent (A: /root/visual_review · B: /root/technical_review).

Target: all public marketing page families beyond the homepage, including the blog. Review only; no application changes, media publication, merge, or deployment. The existing localhost preview remains the review target. Homepage release approval remains pending.

## Assessment

The public site has a credible evidence-first foundation and strong measured local performance. Its largest design weakness is the time it takes to reach useful content: oversized blog artwork, long mobile documentation navigation, repeated methodology qualifications, and late pricing definitions. The most important behavioral improvements concern accurate tool scope and accessible, truthful feedback.

No P0 or P1 blocker was established in this bounded review. P2 items below should form the next focused improvement batch; P3 items are polish or further design opportunities. This is not a release certification or a factual/legal audit of every article and policy.

Design specificity: evidence states, coverage limits, approvals, version controls and browser-local tools make the experience recognizably LyraShield. The navy/cyan technical illustrations and repeated card compositions are more interchangeable. Bring actual product artifacts and reader tasks forward before adding decorative effects.

### Heuristic assessment

Assessment A scored the sampled visual experience independently, before receiving Assessment B's detector findings. Scale: 0–4 per heuristic; a design judgment, not a compliance percentage.

| Heuristic | Score | Main observation |
| --- | ---: | --- |
| Visibility of status | 3 | Evidence and availability states are generally honest; some tool scope and copy feedback need work. |
| Match with readers' language | 2 | Pricing units and evidence terminology need earlier, concrete explanations. |
| User control | 3 | Working disclosures and local controls; mobile navigation becomes cumbersome. |
| Consistency | 3 | Cohesive themes; dates and documentation feedback vary. |
| Error prevention | 3 | Useful boundaries; file selection cap needs explicit handling. |
| Recognition over recall | 3 | Breadcrumbs and TOCs help; definitions are sometimes distant from decisions. |
| Efficiency | 3 | Full-library blog search works; docs filtering and mobile browsing need clearer scope. |
| Minimalist presentation | 2 | Blog imagery, repeated copy and expansive navigation delay the main task. |
| Error recovery | 3 | Generally useful states; clipboard and script-unavailable recovery need attention. |
| Help and documentation | 3 | Substantial guides and examples, with opportunities to improve finding them. |
| **Total** | **28/40** | |

## Coverage and verification

- Mechanically crawled all **262 sitemap routes** with the built-site crawler: no reported violations. Its additional checked-link count concerns off-sitemap internal destinations, not the total links on the site.
- Blog crawler passed for **160 published articles, 6 tag archives and 220 referenced images**.
- Independent visual assessment covered 20 distinct routes across pricing, agents, methodology, evidence, controls, WebMCP, research, AI safety, about, demo, support, blog, categories, articles, tools, comparisons and docs. Desktop 1280×720 and mobile 390×844 samples; selected light/dark checks.
- Technical runtime checks additionally covered Claude Code docs, RLS checking and capped secret-file selection. Parent checks covered privacy, security reporting, terms, terms of sale, the locally disabled scan page and 404 recovery.
- This is representative template and interaction review, not a manual read of all 160 articles or every docs/comparison page.
- Local Lighthouse 13.6 measurements used the compressed preview and a separate Chrome profile. These are lab samples, not production field metrics.

| Local page | Performance | Accessibility score | Best practices | SEO score | LCP |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/blog` | 100 | 100 | 96 | 100 | 1.1s |
| `/blog/ai-app-prelaunch-security-checklist` | 98 | 100 | 96 | 100 | 2.4s |
| `/pricing` | 100 | 100 | 96 | 100 | 0.9s |

The 96 best-practices results include local-preview CORS errors against production Myra/account-preferences services; they do not establish a production outage and are not a reason to broaden production CORS. The aggregate accessibility score does not mean every accessibility audit passed: the blog label/name mismatch below was separately reported.

## Prioritized fixes and improvements

### P2 — confirmed behavior and accessibility defects

1. **Make secret-file result scope exact.** The introduction documents a 20-file cap, but selecting 21 files silently slices the selection. A safe synthetic test with a detectable pattern only in file 21 returned “No high-confidence patterns found in the selected files”; selecting that final file alone detected the pattern. Show selected/scanned/skipped counts, omitted filenames and a partial-review state, or reject the oversized selection before running. Also implement the promised non-text filtering and explicit per-file read errors. Keep all analysis local. Add regression coverage for the cap and skipped/error states. Source: `apps/marketing/src/pages/tools/[slug].astro:217–229`.

2. **Include visible blog-link text in its accessible name.** “Read article” links use `aria-label="Read {title}"`, omitting “article”. Lighthouse flagged ten instances under `label-content-name-mismatch`. Use `Read article: {title}`, or retain visible wording and add a screen-reader-only title. This supports voice navigation and WCAG 2.5.3 Label in Name. Source: `apps/marketing/src/components/BlogCard.astro:57–58`. Reference: [W3C Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html).

3. **Announce docs copy success and provide real recovery.** After copying, visible text becomes “Copied” but the accessible name remains “Copy code to clipboard” and there is no status announcement. Add a polite shared status. The source-only failure path says “Press Ctrl+C” without selecting code; make recovery selectable and platform appropriate. Copy success was observed; clipboard failure was source-inspected, not forced. Source: `apps/marketing/src/layouts/DocsLayout.astro:176–196`.

4. **Describe documentation search honestly.** The field says “Search documentation” but filters navigation labels only. Entering “OAuth” returned “No matching page” while the current guide contained OAuth. Immediately relabel it “Find a guide or integration” and state its scope, or implement article-content search with useful excerpts. Source: `apps/marketing/src/layouts/DocsLayout.astro:85–93,145–160`.

5. **Give browser-local tools a script-unavailable state.** With JavaScript disabled, the RLS check button remains enabled and does nothing; even the initial output hint is script-added. Server-render the hint and a useful `noscript` explanation, and enable controls after handlers initialize. Preserve readable educational content and the local-only processing boundary. Source: `apps/marketing/src/pages/tools/[slug].astro:55–84,183–185,232–234`.

6. **Unify publication-date formatting.** Blog cards and articles use Asia/Kolkata while search uses UTC. The PHP2Shell sample changes from October 24 to October 23 when searched. Centralize the editorial date formatter across cards, search, article metadata and relevant schema. Preserve the real timestamp and only update modification dates for substantive edits. Sources: `BlogSearch.astro:29`, `BlogCard.astro:40`, `BlogPost.astro:195`.

### P2 — premium presentation and information hierarchy

7. **Put blog titles and usefulness ahead of decorative artwork.** The desktop featured image can occupy an entire screen before its title is visible. Mobile article titles and 16:9 artwork similarly delay the answer. Use a desktop split feature with title, category, concise summary and reading time beside a smaller image. Put text before imagery in DOM order. On articles, follow the title/metadata with a direct answer or short takeaway and compact contents; use diagrams or smaller figures when they explain the topic. Reduce the article H1's current maximum size and extreme negative tracking without shrinking body text. Sources: `BlogCard.astro:18,84,205`, `BlogPost.astro:220,346`, `pages/blog/[...page].astro:178`.

8. **Explain pricing units before the plan decision.** Cards emphasize 210/850/4500 minutes and Deep/Custom capacity before the 3× definition; the full definition is near the end. Add one plain definition above the cards, show the applicable multiplier beside the relevant capacity, and give a transparent example such as 10 elapsed minutes × 3 = 30 units. Avoid converting capacity into speculative scans/month. Make Local's “Launching later” state visible before someone selects it. Preserve shared prices and entitlements. Source: `pages/pricing.astro:128,151,341,465`.

9. **Replace the mobile docs link wall.** Expanded navigation exposes 57 links: 9 general and 48 client workflows. They wrap into chips and push the article far below the viewport. Use a compact general list, a separate integrations disclosure/filter, a visible current location and an easy collapse control. Keep snippets and educational copy available without script. Source: `layouts/DocsLayout.astro:57,94,601`.

10. **Bring the methodology example forward.** The intro and TLDR repeat the same evidence distinctions and cautions before the useful record. Consolidate them into a short introduction and a three-state key; bring the existing captured record forward with scope, coverage and outcome callouts. Keep future-state information secondary and preserve factual limitations. Source: `pages/methodology.astro:101,109,119`.

11. **Make category archives selective and bounded.** Verification contains 146 and Vibe Coding Security 145 of the 160 published articles; other categories contain 46–73. This overlap weakens browsing. Give articles a meaningful primary category and reserve secondary tags for narrower facets. Category pages currently render all matching entries; use a bounded page size, real linked pagination and full-library search. Keep existing URLs and add redirects only when genuinely necessary. Source: `pages/blog/tags/[tag].astro` and `components/BlogSearch.astro`.

12. **Revisit blog pagination canonical policy.** Pages 2+ deliberately canonicalize to `/blog` and use `noindex,follow`, although they contain distinct article lists. If archives should be discoverable, provide unique titles/descriptions and self-referencing canonicals for distinct pages, with ordinary crawlable links. Decide indexability intentionally; do not treat different article lists as duplicate pages merely because their descriptions match. Google recommends unique URLs and canonicals for paginated pages. Source: `pages/blog/[...page].astro:44–49`; [Google pagination guidance](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading).

13. **Make article endings task-specific.** The shared ending prioritizes a multi-field product-updates form, followed by four generic next-step cards. Put one relevant action first: try the related tool, inspect the methodology, follow the client setup guide, or view a product example. Keep the optional newsletter compact; make role/project details optional and secondary. This is a design recommendation, not evidence of a measured conversion loss. Source: `components/BlogCta.astro`, `components/WaitlistForm.astro`.

14. **Make demo fallback usable without a mail application.** When booking is unavailable, the page relies on a `mailto` action. Display a selectable support address with a copy control, useful alternative contact route and a prefilled subject/body requesting timezone and preferred times. Reflect the actual availability in the introduction. This review did not test a live booking provider. Source: `pages/demo.astro:14,56,86`.

### P3 — polish and editorial consistency

- **Responsive article images:** AVIF/WebP `srcset` currently supplies one 1600px candidate; `sizes` alone cannot select a smaller width. At 390px the sampled 356px image used the 1600px, 83,678-byte AVIF. Generate sensible width candidates if traffic justifies it, preserving dimensions, alt text, lazy cards and prioritized article heroes. This is bandwidth polish; the sample does not demonstrate a failing Core Web Vital. Sources: `BlogCard.astro:23–33`, `BlogPost.astro:221–232`.
- **Client count:** shared blog CTA says “Claude Code, Cursor, Codex and 23 more clients”, while the current registry contains 48 documented workflows. These may be different units; use an accurate labeled count derived from the owning source, or remove the hardcoded number.
- **Authorship:** first-person founder articles currently attributed to LyraShield Team should name the actual author when factually appropriate, with an optional team reviewer. Add consistent author bios and visible revision notes for substantive technical updates.
- **Docs reading measure:** constrain prose to roughly 70–80 characters while letting code and tables use more space. Keep local horizontal scrollers.
- **Research status:** use a neutral informational treatment for “planned” rather than a red warning, unless an actual failure or risk is being conveyed.
- **Design tokens:** reconcile intentional editorial font/radius values with the design-system documentation. Do not mechanically replace the detector's advisories or introduce broad CSS churn.

## Recommendations by page family

| Page family | Recommended direction | Evidence boundary |
| --- | --- | --- |
| Blog index, categories, articles | Editorial hierarchy, direct answers, selective categories, bounded archives, purposeful imagery, contextual endings and accurate dates. | Concrete hierarchy and interaction findings above; no exhaustive factual audit of all posts. |
| Pricing | Explain units/multipliers beside the decision; shorten repeated caveats; retain full terms and shared data. | Mobile/desktop and light/dark samples; no purchase or entitlement changes. |
| Agents and docs | Lead with the supported workflow; compact client discovery; improve search/copy feedback; place a copyable setup example early. | Registry and representative client docs checked; not every client installation executed. |
| Methodology, evidence vault, Vibe Security 50 | Show one labeled evidence example, then explain states and coverage. Use concrete scope/receipt callouts and link deeper details. | Preserve actual limitations; avoid implying illustrative examples are customer evidence. |
| WebMCP and tools | Show a concrete local example, result scope and recovery. Prioritize accuracy over adding motion. | Synthetic local inputs only; no real secrets, uploads or paid scans. |
| Comparisons | Add a short “choose this when” summary and source/date any changeable competitor facts; use a compact shared comparison structure. | Sampled Snyk page; competitor claims were not all externally fact-checked. |
| Research, AI safety, About | State current availability early, reduce repeated qualifications, add real authorship/product artifacts, use restrained status styling. | No invented customers, certifications, awards or planned capabilities presented as shipped. |
| Demo and support | Keep one clear primary contact path with selectable details and useful fallback states. | Booking/provider delivery and real support response times unverified. |
| Privacy, terms, terms of sale, security reporting | Add compact summaries/TOCs where length warrants; keep full readable policy text, contacts and real dates. | Readability recommendation only; no legal-validity opinion or policy shortening without owner review. |
| Scan | Preserve the explicit local “Scanner API not connected” state; disable unavailable actions and retain helpful navigation. | Expected local configuration, not evidence of a production defect. |
| 404 | Retain current useful recovery links and compact presentation. | No issue established in the desktop sample. |

## SEO, AEO and GEO recommendations

The crawled routes and sampled metadata are healthy. The remaining opportunity is clearer editorial structure and trustworthy provenance, not more generic search copy.

- Give each article a direct, visible answer near the top, followed by steps, caveats and useful first-party links. Add question-based headings where they match the actual reader's task.
- Keep title, visible publication/modification dates, author, canonical and article structured data consistent. Verify author identities before changing schema.
- Use meaningful primary categories and crawlable archive links. Resolve the pagination policy deliberately.
- Preserve the distinction between detected, retest-confirmed and inconclusive outcomes. Keep product examples clearly labeled and avoid adding unearned review/rating/certification markup.
- Audit topical overlap before consolidating or redirecting articles. This review establishes category overlap, not that every overlapping article is duplicate content.
- When revising competitor or rapidly changing technical articles, verify primary sources and show a real review date. Do not refresh dates without substantive review.
- Avoid new FAQ schema on pages without matching visible FAQs, hidden crawler text, keyword stuffing or unsupported promises about rankings and AI citations.

These steps improve reader comprehension and crawler interpretation; they cannot guarantee rankings, indexing or AI citations. A full keyword, backlink, Search Console, server-log and external citation audit remains outside this review.

## Motion and microinteraction guidance for the remaining pages

Keep the established homepage motion vocabulary: short button/link feedback, one-time opacity/translation entrances and clear disclosure states. Preserve native scrolling, reduced-motion handling and visible server-rendered content. Avoid loading cinematic or heavy animated effects into long articles and docs. Navigation, search, copy and form feedback should remain immediate, independent of media decoding. Existing shared reveal handling already checks reduced motion and Save-Data; no additional scrolling defect was established by this bounded review.

## Reader perspectives and strengths to preserve

- A newcomer needs a plain explanation and concrete example before unfamiliar evidence taxonomy or pricing arithmetic.
- A phone reader needs the answer before a large illustration, and a guide before dozens of navigation chips.
- An evaluator needs actual scope and outcome examples, truthful tool limits, clear availability and a usable next step.

The emotional journey is calm and credible, then sometimes slows under repeated qualification or generic imagery, and becomes strongest at real artifacts, local tools and copyable setup. Bring those useful moments earlier.

Preserve honest limits and status language, full-library search and result announcements, article breadcrumbs/TOCs, readable light/dark typography, contained code/table scrolling, browser-local tool processing, useful empty states, and 404 recovery.

## Suggested implementation sequence

1. **Trust and accessibility:** scoped file results, link names, copy status/recovery, truthful docs filtering, script-unavailable tools, shared dates.
2. **Blog and mobile reading:** feature/article hierarchy, mobile docs navigation, category/pagination policy, contextual endings and responsive image variants.
3. **Product evaluation:** pricing definitions, methodology artifact hierarchy, demo fallback and focused page-family polish.

For a subsequent implementation plan, choose whether to retain and simplify the current technical artwork or move the blog toward a more editorial treatment with diagrams and smaller images. Choose the first implementation scope from the three batches above; this review does not authorize deployment.

## Evidence and limitations

Generated evidence is under `output/playwright/site-review-2026-10-28/` (gitignored): site crawl and route inventory, three Lighthouse JSON reports, Assessment B report/browser evidence, detector invocation/output and screenshots.

Representative screenshots:

- `assessment-a/blog-feature-desktop-light.png`: oversized blog feature image before its title.
- `assessment-a/docs-mobile-expanded-light.png`: expanded mobile navigation link wall.

Assessment B ran the detector once over 75 source targets: 84 records, comprising one primary warning and 83 advisories. The primary side-tab warning is unused CSS with no rendered element; the advisory colors are email HTML and most others are intentional font/radius values. No detector warning was promoted without source/runtime validation.

No physical-device, screen-reader, Firefox, production field-CWV, live booking, account, billing or provider acceptance is claimed. Browser-emulated samples and local Lighthouse cannot establish those outcomes. No paid scans were run. Temporary synthetic fixtures were removed; review tabs closed, overrides reset and shared theme restored to System. The user's original tab and localhost server were retained. The annotation overlay was unavailable through the read-only browser surface; no source injection or evaluation bypass was used.
