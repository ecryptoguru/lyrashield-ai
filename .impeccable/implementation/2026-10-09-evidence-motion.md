# Evidence in motion — implementation receipt

Date: 2026-10-09. Branch: `codex/ui-ux-audit-fixes`.

Approved direction: A, with additions 7, 8, 9, 10, 11, 12 and 13. The subsequent
instruction to base the experience on the new dashboard is included.

## Delivered

- **A / focal sequence:** example EX-014 persists through the journey. Scope,
  review method, evidence, approval and retest context accumulate around the same
  finding. Detected never becomes verified. Incomplete retest coverage remains
  inconclusive and the report remains insufficient evidence.
- **7 / navigation:** seven native chapter links, current-stage tracking,
  horizontally scrollable mobile navigation and a direct product-preview link.
  The selected label stays visible within its own navigation strip.
- **8 / pacing:** desktop chapters use 420px minimum height rather than the
  previous 840px/115svh video story. The final chapter reserves enough space to
  keep the complete artifact and report visible. Mobile chapters flow naturally
  without viewport-sized gaps or pinned cards obscuring the text.
- **9 / product previews:** current dashboard component captures in both themes,
  with an enlarged native dialog, close/Escape, explicit keyboard image scrolling,
  focus restoration and immediate scroll-lock cleanup. The phone can pan the
  enlarged image instead of shrinking the UI to illegible text.
- **10 / tabs:** brief interruptible content transitions, existing roving focus,
  Arrow keys plus Home/End. Exactly one panel remains active.
- **11 / feedback:** stationary hero conversion controls, pressed-state feedback,
  CLI command copying, accessible copied/error announcements, and retained URL
  authorization/validation boundaries.
- **12 / theme continuity:** optional View Transitions capture the palette and
  product-image variants together. Ordinary updates remain the fallback. Rapid
  clicks and storage changes keep the requested preference coherent.
- **13 / report assembly:** a bounded entrance composes the example into a report
  with scope, approval and retest limitations still visible.

Reduced motion and Save-Data keep a complete record rather than hiding the
content. The mobile composition deliberately keeps the complete illustrative
record in normal flow; the desktop progressively attaches receipts. There is no
continuous animation loop, new animation dependency, new scanner request or
product-side simulated approval operation.

## New dashboard basis

The fixture renders the actual `TrustCommandCenter`, `FindingsClient`, `AgentsGrid`
and current dashboard stylesheet. Public synthetic identities and data replace
any need for account access. Captures are labeled as **current dashboard
components with illustrative data**, not full authenticated page screenshots or
production results. Source and asset SHA-256 fingerprints are retained in
`output/playwright/evidence-motion/capture-provenance.json`.

The hero and journey adopt the dashboard's scope/coverage-first hierarchy.
The homepage no longer uses the old console-home/issues/coding-agents screenshots.
Legacy assets remain for their existing documentation consumers.

## Source changes

- `apps/marketing/src/components/landing/EvidenceWorld.astro` and new
  `evidence-journey.ts`: compact evidence sequence and progressive controller.
  Removed the obsolete `evidence-world.ts` video controller.
- `HeroProductFrame.astro` and new `product-preview.ts`: current paired captures
  and accessible enlargement.
- `PremiumHero.astro`: authored artifact entrance, stationary critical content,
  EX-014 continuity and scope/coverage fields.
- `apps/marketing/src/pages/index.astro`, `components/Header.astro` and
  `styles/global.css`: tab/copy feedback and theme continuity.
- Six `apps/marketing/public/product/current-*.webp` assets and their README;
  `e2e/browser/marketing-product-preview.{html,tsx}` for reproducible captures.
- Focused browser regressions plus updates to obsolete video-story assertions
  and analytics source coverage. Public evidence-claim checks remain active.

Earlier audit fixes and unrelated dashboard working-tree changes were preserved.
No dashboard runtime component was edited for this landing-page implementation.

## Verification

Authoritative commands ran raw, with complete output retained under
`output/playwright/evidence-motion/`:

- Marketing unit tests: **535 passed, 59 files**.
- Impacted browser suites: **67 passed**, including desktop/mobile, both themes,
  preview repetition and Escape, focus, clipboard error recovery, chapter links,
  no-JavaScript fallbacks, dynamic reduced motion and 200% text sizing. Prior
  marketing audit regressions were included.
- Marketing Astro check: **0 errors, 0 warnings**, one existing Myra async-function
  hint.
- Marketing lint: passed.
- Browser fixture TypeScript check: passed with the web workspace compiler and
  `e2e/browser/tsconfig.json`.
- Explicit Prettier checks for owned TS/TSX/tests/HTML/docs: passed. New component
  stylesheet blocks were formatted with Prettier's CSS parser.
- Production marketing build: passed; scheme guard applied and **274 prerendered
  HTML files passed CSP validation**.
- `git diff --check`: passed.

The bounded rendered review found text-zoom overflow and report-stage clipping;
these were repaired. Functional regression testing also caught native dialog
close-event timing; focus and scroll state now restore synchronously on explicit
close/Escape. Final browser verification passed all 67 cases.

The design detector produced 80 advisory token/type findings and one dynamic
preview-image warning. The warning was resolved by supplying a valid initial
image, alt and dimensions before JavaScript swaps the selected capture. No
broad detector ignores were added.

## Evidence and limits

Representative final images: `report-dark-1440.png`, `report-light-1440.png`,
`report-dark-390.png`, `report-light-390.png`, `hero-1440.png`, `hero-390.png`.
The same directory retains initial inspection captures and new dashboard images.

Browser verification used local Chromium and emulated viewports. Physical
midrange-device frame rates, Safari/Firefox behavior, screen-reader operation,
Core Web Vitals and production account/provider flows were not measured. Local
preview inherits developer Myra/account URLs; its existing CSP blocks those HTTP
connections. No CSP or auth guard was weakened to accommodate that environment.

All work is local and uncommitted. No PR, deployment, merge, account mutation or
paid action was performed. Owned temporary browser/server sessions were closed.
