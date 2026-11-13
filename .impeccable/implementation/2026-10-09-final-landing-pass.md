# Final landing review and polish

Date: 2026-10-09. Local branch: `codex/ui-ux-audit-fixes`.
Target: `apps/marketing/src/pages/index.astro` and its landing components.
Preview: http://localhost:8787/?review=final-polish

## Review scope and findings

Two independent reviewers assessed the rendered landing in both themes, desktop and phone layouts, and checked navigation, theme controls, previews, keyboard tabs, motion preferences and no-JavaScript content. Assessment A completed before B released its detector findings. No blocking interaction defect was found in their sampled flows. The design assessment scored 23/32 before this polish (heuristics 7 and 9 not applicable); this is a scoped review, not a certification or a measured post-fix score.

The architectural world and continuous EX-014 evidence story are distinctive and coherent. Preserve the brighter camera sweep, current dashboard imagery, explicit illustrative-data labels and incomplete-evidence outcome.

| Finding                                                                                    | Resolution                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main dashboard window stretched alongside two stacked thumbnails; Findings crop hid labels | Main capture receives a full-width row. Companion captures retain natural aspect ratios. Expand controls sit below the image, not over evidence.                              |
| Enlarged phone screen lacks a visible pan cue and uses a generic title                     | Added swipe/arrow-key guidance, associated it with the focusable image region, selected-screen titles, and reset pan position on each open.                                   |
| Fixed mobile signup action competes with end-of-page signup                                | IntersectionObserver hides it when the final or footer signup action is visible and restores it elsewhere.                                                                    |
| Opaque blue supporting bands disconnect the background scene                               | Applied 92% dark-theme / 96% light-theme fill to `#different` and `#free-scan`. No backdrop blur. Inner cards, screenshots, controls and evidence panels retain stable fills. |
| Duplicate `cta` query keys in plan links                                                   | One plan-specific attribution key per URL.                                                                                                                                    |
| FAQ length weakens late-page pacing                                                        | Retained the explicitly specified five-open behavior and all factual limits. Content restructuring remains optional.                                                          |

Coverage and pricing are outside the film stage. Making those bands translucent would reveal only the plain page background, so they remain unchanged. The mobile journey bar is narrow but does not collide with Motion; the initial overlap suspicion was disproved by rectangle measurements.

## Scroll diagnosis and repair

Previous jump-and-settle checks did not establish continuous visual smoothness. Sustained measurements showed uneven desktop frame delivery. The original chapter mapping also changed camera speed abruptly when transitioning from the long opening band to shorter chapters.

- Native document scrolling remains immediate; only the decorative video target eases over 180 ms.
- Monotone cubic interpolation keeps chapter endpoints exact and blends camera speed across boundaries.
- Retain the last decoded decorative frame during chapter transitions instead of flashing the poster. HTML evidence remains authoritative; static preferences and decoder failures still use chapter posters.
- Block scroll seeks until the startup frame handshake completes. A delayed-metadata regression reproduced the original early-seek race and now passes.
- Desktop web delivery is 1440×810, CRF 28 and a two-frame GOP, reducing decoder work while fitting 16 MiB. The native desktop master remains 1920×1080. Portrait delivery remains 720×1280, CRF 24, GOP 4 under 10 MiB; native portrait master remains 1080×1920.
- Both exact installed films and their fourteen derived posters are locally validated. These remain review drafts, not final masters.

## Prior-task reconciliation

| Workstream                                                | Current status                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial marketing, free-tools, blogs and auth audit/fixes | Prior receipts record implementation and local tests in `2026-10-09-ui-ux-fixes.md`. This pass reran marketing unit coverage and selected marketing/browser regressions; it did not rerun the entire authenticated app. |
| Direction A and additions 7–13                            | Implemented in the prior evidence-motion pass. The v3 world supersedes its older camera/media controller; current themed dashboard captures and interactions remain.                                                    |
| Scroll-world Tasks 0–2                                    | Local range delivery, v3 contract, continuous world and camera implemented. Production v3 asset readback remains pending publication.                                                                                   |
| Task 3                                                    | Brighter desktop/portrait drafts and requested dramatic sweep available locally; final visual acceptance remains pending.                                                                                               |
| Tasks 4–5                                                 | Controller and whole landing integrated; final polish in this receipt.                                                                                                                                                  |
| Task 6                                                    | Encoding/validation/publication tooling implemented. Final-quality master export and remote upload remain outstanding.                                                                                                  |
| Task 7                                                    | Local functional, accessibility and actual-film performance checks recorded below. Physical iOS remains unverified.                                                                                                     |
| Task 8                                                    | Local review package only. No publication, PR, merge, deployment or production acceptance.                                                                                                                              |

## Review tooling

CLI detector: zero advisories in the index page; 81 landing-component advisories (42 color, 36 type-size, three radius). These are potential documented-token drift, not 81 verified UX bugs. Browser overlay was blocked by the existing script CSP; no CSP bypass occurred. Manual browser checks and CLI output supplied the evidence. Temporary detector server and reviewer tabs were closed; the localhost preview remains running.

## Validation receipts

- Marketing on the fresh main candidate: 559 tests in 60 files passed. Motion: 30 tests passed.
- First integrated browser pass: 59 passed, one expected disabled-scanner skip. WebKit motion: 11 passed.
- Actual-film performance: all 12 checks passed. Includes 240 jump-and-settle trials at 1×/4×/6× CPU, cold 4 Mbit/s + 150 ms RTT startup, native wheel reversals and continuous forward/reverse motion.
- Under 4× CPU, continuous new-frame p95 interval: desktop 33.1 ms, phone-sized Chromium 24.8 ms. Maximum intervals: desktop 58.1 ms, phone 124.4 ms. These measure actual video presentation callbacks, not generic rAF FPS; they do not guarantee frame pacing on physical phones.
- Final interaction/contrast confirmation: 53 passed, including theme-paired previews, keyboard focus/panning, tabs, clipboard failure, enlarged-text layouts and worst-background translucency contrast. Suites overlap; counts are not a unique-test total.
- Marketing lint, Astro validation (zero errors/warnings, two hints) and browser-test TypeScript passed. Production-shaped preview build/CSP validation passed.
- Six final viewport/theme samples: 1440 dark/light, 390 dark/light, 320 light, 768 dark. Document width equals viewport in each. Existing 200% text-size reflow check also passed.
- Translucent outer-band muted-text contrast was calculated against both extreme background colors: minimum 5.65:1 dark / 4.67:1 light. Added a browser regression that resolves actual CSS colors onto black and white canvas backgrounds. This bounds these surfaces, not every possible page element.
- One additional interaction run was interrupted after 17 passes when local Wrangler's ProxyController exited; remaining navigations reported connection refused. Rebuilt/restarted the local preview; the complete affected interaction/contrast suite then passed all 53 checks. The interrupted run remains recorded separately.

Evidence directory: `output/playwright/final-polish/`. Actual-film measurements: `output/playwright/scroll-world/{continuous,catchup,cold,wheel}-*.json`. Logs and exact draft checksums: `.superpowers/sdd/2026-10-09-premium-scroll-world/`.

## Remaining admission gates

Final-quality master export awaits reviewed-draft acceptance. Physical iOS playback, production v3 range/CORS/cache readback, publication, exact-head CI and deployment remain unverified. Local scanner submission is deliberately unavailable. No paid generation or production mutation occurred.
