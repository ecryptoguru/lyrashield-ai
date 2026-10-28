# Premium homepage — localhost review

Date: October 28, 2026. Branch: `codex/premium-landing-local-review`.

Status: implemented and locally verified, awaiting founder review. Nothing has
been merged, deployed or published. This document is local evidence, not a
production acceptance or field-performance claim.

## Review

Open <http://localhost:8787/>. The range-capable preview is also available at
<http://127.0.0.1:8787/> while the local preview process is running.

Review the hero, scroll slowly through the workflow, reverse direction and make
fast chapter jumps. Check both themes, the motion toggle, dashboard view buttons
and expanded previews, FAQ keyboard interaction, and the phone layout. The Lite
Check deliberately shows its disconnected state locally; no real target scan or
paid acceptance was run. Its private handoff and consent contracts have separate
regression coverage.

Founder approval of this localhost experience is required before any merge,
media publication or deployment. A merge can trigger production deployment.

## Changes

- Simplified hero and page order; moved the existing consent-bound URL form to
  the dedicated Lite Check section, retaining its IDs, analytics allowlist and
  private session-storage handoff.
- Replaced repeated feature/coverage prose with concise workflow chapters and
  links to existing methodology, coverage, agent and evidence-vault pages.
- Kept shared pricing, one illustrative detected finding, inconclusive retest
  limits, and real demo-workspace screenshot provenance.
- Added restrained button/link feedback, native FAQ transitions and one console
  arrival; content remains visible without JavaScript and spatial effects honor
  reduced motion.
- Corrected the opening timeline so the viewport anchor does not seek into the
  film before scrolling. Suspended decoder work offscreen/in hidden tabs,
  rejected late offscreen callbacks, observed chapter layout changes and tied
  chapter state to presented frames.
- Aligned homepage description, four FAQ answers/JSON-LD and editorial sitemap
  freshness. The existing canonical, entity IDs, robots controls and social card
  remain valid. The existing `llms.txt` summary still describes the shipped
  workflow correctly.
- Added Brotli/gzip text compression to the local motion proxy, matching the
  production edge's observed Brotli delivery. Decoded HTML equality and unchanged
  MP4 byte ranges are integration-tested. Generated media was not committed.

Primary implementation is the homepage composition and landing components,
existing scroll controllers, media-copy manifest and local preview script.
Tests, the optional WebKit review configuration and the homepage design brief
were updated alongside them. No backend or database interface changed.

## Content and layout measurements

Baseline: current production homepage. Candidate: the built localhost page.
Chromium, identical viewport dimensions (844px high below 1024px; 900px above),
both themes, fonts loaded. Words use rendered `main.innerText` with the pricing
section removed; native collapsed answers and hidden product panels are excluded.
Navigation and footer are outside `main`. Both themes produced matching counts.

| Width  | Visible words | Reduction | Page height     | Reduction |
| ------ | ------------- | --------- | --------------- | --------- |
| 360px  | 1581 → 454    | 71.3%     | 20227 → 11120px | 45.0%     |
| 390px  | 1581 → 454    | 71.3%     | 19664 → 10905px | 44.5%     |
| 768px  | 1583 → 456    | 71.2%     | 15575 → 8799px  | 43.5%     |
| 1280px | 1565 → 438    | 72.0%     | 14138 → 9106px  | 35.6%     |
| 1440px | 1565 → 438    | 72.0%     | 14265 → 9158px  | 35.8%     |

The 390px primary CTA ends at approximately 410px from the top. All requested
widths pass overflow checks; common-width reflow and 200% text also pass in
Chromium and WebKit. Screenshots and raw measurements are in the gitignored
`output/playwright/premium-landing/{before,after}/` directories.

## Motion evidence

The final tests use the exact currently published desktop and portrait films,
copied only into generated local preview output. The existing ignored source
films differ slightly in size, so the early local baseline film measurements
must not be described as an exact production-film comparison.

Published render: `74787c7fe35196b2`, 56 seconds, H.264, 30fps. Both production
and localhost return HTTP 206 byte ranges. Final local bytes match the downloaded
production bytes:

- Desktop SHA-256: `d124f71520f65722359b74734c169c75d6ea67745f7d4ded996e612b4195f794`.
- Portrait SHA-256: `6bd6433397196604e082143a7f41722c837d57a90702777191e73b446c56072a`.

| Profile        | Catch-up p95 at 1× / 4× / 6× CPU | Cold film startup | Continuous frame interval p95 / max | Wheel rAF p95 |
| -------------- | -------------------------------- | ----------------- | ----------------------------------- | ------------- |
| Desktop        | 190.4 / 199.1 / 199.7ms          | 322.3ms           | 26.7 / 58.6ms                       | 16.8ms        |
| Phone viewport | 216.8 / 223.4 / 241.2ms          | 297.2ms           | 58.6 / 143.4ms                      | 17.2ms        |

Cold-film profile: 4 Mbit/s, 150ms RTT, empty browser cache; phone CPU at 4×.
Continuous-film and wheel profiles use 4× CPU. All 12 existing actual-film gates
pass, without unexpected fallback. Wheel traces contain no recorded long tasks.
rAF scheduling is not compositor FPS, and emulation is not physical-phone proof.
Raw timing files are under `output/playwright/premium-landing/after/performance/`.

## Verification

- Marketing unit suite: **618 passed** across 64 files.
- Motion media contract suite: **30 passed**.
- Broad Chromium/phone regression run: **249 passed**, two intentional skips.
- Final focused Chromium/phone run after startup and compression changes:
  **136 passed**, one intentional skip for the duplicate viewport matrix.
- Final actual-film performance suite: **12 passed**.
- Final desktop/phone WebKit review: **26 passed**.
- Marketing ESLint, Astro typecheck, root E2E typecheck, production build, CSP
  validation, formatting and `git diff --check` pass. Astro reports two existing
  informational hints in the unchanged Myra/scan sources, with zero errors or
  warnings.
- Repository markdownlint reports five existing issues in the ignored
  `output/playwright/final-technical-review/report.md` and
  `output/playwright/landing-audit/assessment-b.md` artifacts. The changed design
  and review documents have no reported markdownlint issues. Those unrelated
  artifacts were preserved.
- Site-wide built SEO gate passes. Homepage has one H1, canonical origin,
  crawlable workflow text, matching native FAQ/JSON-LD and actual editorial date.
- Impeccable detector: 58 advisory font/color findings, no non-advisory findings.
  These were reviewed against the existing cinematic palette and the intentional
  fluid homepage type scale recorded in the surface brief.

Lighthouse 13.6, mobile simulated slow 4G/4× CPU, compressed local preview:
**97 performance / 100 accessibility / 96 best practices / 100 SEO**.
FCP **1.1s**, LCP **2.58s**, TBT **10ms**, CLS **0**. The LCP remains approximately
81ms above the 2.5s target; that target is not marked passed. The best-practices
loss is from the production account-preference/Myra APIs rejecting localhost
CORS, not a claim about production API behavior. The accessible-name mismatch
on expanded-preview buttons was fixed and the audit passes.

The initial uncompressed local Lighthouse run measured 74 performance and 3.9s
LCP. Treat that as a preview-delivery diagnostic, not a production before/after
speed claim. Local HTTP and emulated hardware do not establish deployed CWV.
Physical iOS/Android, screen-reader sessions and real-user field metrics remain
unverified.

Search readiness follows factual, crawlable content, internal links and matching
structured data. Google documents that its AI features use the same foundational
SEO requirements; there is no special AI schema required. See [Google's AI
features guidance](https://developers.google.com/search/docs/appearance/ai-features).
No ranking, indexing, rich-result or AI-citation outcome is promised.

## Reproduce the review

From the repository root, build with
`pnpm --filter @lyrashield/marketing preview:build`. To keep testing the exact
published film, copy the desktop and portrait MP4s from
`output/playwright/premium-landing/production-media/` into the corresponding
`apps/marketing/dist/client/media-local/assurance-world/v3/local/` directories.
Then, from `apps/marketing`, run `node scripts/preview-motion.mjs`.
A normal rebuild restores the pre-existing ignored local films; it does not
publish or alter production media.

Use the package's Playwright configuration for Chromium/phone checks and
`playwright.review.config.ts` for optional WebKit review. Actual-film performance
checks intentionally require real local media and are skipped with synthetic CI
fixtures. The body-copy/height budgets have a live-production baseline recorded
in the dedicated premium-homepage browser test.
