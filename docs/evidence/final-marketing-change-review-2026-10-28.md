# Final marketing change review

Date: 2026-10-28. Branch: `codex/premium-landing-local-review`.
Initial review followed by the authorized repair and PR preparation. Deployment remains gated.

## Verdict

The initial review identified three reproducible P2 UX issues, recorded below.
The subsequent repair bounds category grids, labels category search accurately,
and preserves matching docs groups across breakpoints. Enlarged-text tests now
assert the computed 32px root font and include category archives. No P0/P1
regression was confirmed in the reviewed changes. This is not a guarantee that
all defects or accessibility issues have been found.

Impeccable technical assessment: accessibility 3/4, performance 3/4, theming 4/4,
responsive design 3/4, implementation integrity 3/4; total 16/20 (Good).
The existing detector findings were reviewed as context; the detector was not
rerun. Scores are a bounded review judgment, not WCAG certification.

## Findings

### P2: Category navigation overflows at 200% text

Location: `apps/marketing/src/pages/blog/tags/[tag]/[...page].astro:140`.
The More categories grid retains a 15rem minimum. At a 390px viewport with the
root font confirmed at 32px, `/blog/tags/verification` has 512px document width.
The enlarged cards force horizontal page scrolling. Use a container-bounded
minimum, permit labels/counts to wrap, and add category archives to enlarged-text
coverage. This is a reflow/accessibility regression in the replacement archive.

### P2: Category search promises the entire library

Location: `apps/marketing/src/pages/blog/tags/[tag]/[...page].astro:87` and
`apps/marketing/src/components/BlogSearch.astro:16-24`.
The category page passes only its primary-topic posts but leaves `showAll` false,
which renders Search published guides and Search across the full article library.
A reader can incorrectly conclude an article is absent when it belongs to another
category. Separate search-scope labels from whether results are initially shown;
keep category results collapsed until a query without claiming global search.

### P2: Responsive docs reset hides active search matches

Location: `apps/marketing/src/layouts/DocsLayout.astro:232-237`.
Reproduction: at 1280px, filter for cursor; the Coding agents group is open.
Resize to 390px and reopen Browse docs. The same query remains, but the only
matching group is collapsed. The resize callback resets group state without
respecting the active filter. Reapply the filter when the breakpoint changes or
keep matching groups open while a query is present.

## Test robustness follow-up

`tests-browser/marketing-public-pages-ux.e2e.ts:277` injects 200% text without
asserting that the computed font size changed. Immediate measurements intermittently
returned 16px; waiting for 32px gave stable evidence. The initial suspicion that
CSP blocked this was disproved: no CSP bypass is needed. Add an explicit computed
font-size assertion before geometry checks, and include category archives.
With that wait, the existing blog, docs, pricing and SQL-tool routes each remain
390px wide at 200% text. Local code/table scroll regions are not page overflow.

## Fresh validation

- Marketing Vitest: 626 passed, 65 files.
- Motion contracts: 30 passed.
- Built-site SEO gate: 283 pages, 0 new violations, 0 baselined, 0 stale entries.
  This command reports 8 internal links checked; it is not an exhaustive link proof.
- `git diff --check`: passed before this report was added.
- Rendered blog inspected in the in-app browser; focused Chromium reproductions
  verified category overflow and docs search state across a breakpoint.
- Earlier production build, lint, Astro/E2E typechecks, 70 Chromium/mobile and
  36 WebKit test passes remain prior evidence, not newly rerun in this review.
- Earlier actual-film measurements remain separate from synthetic motion contracts.
  Physical devices, real assistive technology and production field performance
  remain unverified.

## Positive checks and scope

Reviewed homepage hierarchy/copy, shared trial and pricing references, cinema
pause/resume and presented-frame state changes, local-file bounds/redaction,
responsive-image generation, archives/canonicals/structured data, blog CTAs,
forms, docs navigation, shared header, policy anchors, comparison/methodology,
demo fallback, affected tests and verification reports. Evidence distinctions and
human approval requirements remain explicit. No backend, billing, database or
scan-execution changes were introduced by this marketing work.

Retain the localhost approval gate. Recommended next work is a focused responsive
and interaction repair followed by the corrected tests and final visual polish.

## Repair verification and GitHub review

All three findings are repaired. Category headings also wrap at 200% text in
WebKit. The strengthened browser run passed 74 Chromium/mobile tests (21 matrix
duplicates skipped) and six focused WebKit tests. Fresh unit and motion suites
passed 626 and 30 tests. Production/preview builds, lint, Astro/E2E typechecks,
and the 283-page SEO and 160-article blog crawls passed.

Draft PR #1049 is open. The first CI run found one unformatted review document
and flagged the synthetic redaction fixture as a secret. The fixture was renamed;
its exact historical fingerprint is documented in the existing ignore file.
No real credential was found. Localhost approval remains required before merge.
