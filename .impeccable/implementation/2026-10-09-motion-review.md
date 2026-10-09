# Landing motion review and repairs

Reviewed the implemented A direction and additions 7–13 against the user's report
of weak animation and scroll glitches. This follow-up focuses on the landing
experience and shared navigation. It does not repeat the earlier authentication
or production-service audit.

## Findings and repairs

1. **Chapter navigation flashed the destination before scrolling there.** Browser
   reproduction showed stage 6 → 0 → 1 → 2 → 3 → 4 → 5 → 6 after clicking Report.
   Removed premature click-driven state changes. Native smooth scrolling now
   determines the visible stage, including reverse navigation and interruption.
2. **The sticky evidence scene changed height during the sequence.** Measured
   580px at the start and 802.9px at the report. Reserved receipt/report space and
   compacted the scope layout. The same desktop sequence now stays at 705.6px;
   the report fits below the navigation without pushing the scene upward.
3. **Scroll frames repeatedly rewrote labels, classes and content.** The original
   navigation produced 141 mutation batches. Cached references and a stage guard
   now limit semantic updates to chapter changes. A regression check confirms
   zero non-style mutations while scrolling within one chapter. Only the small
   progress trail updates continuously between chapter boundaries.
4. **Short desktop windows could leave late-stage content behind in a static
   scene.** Complete records now remain visible when the scene cannot fit, with
   ResizeObserver accommodating responsive layouts and enlarged text.
5. **Hero motion ran before an offscreen mobile card was seen.** One-shot
   IntersectionObserver arrivals now begin when the artifact enters view.
6. **Desktop navigation overflowed at enlarged text sizes.** At 1280px and 200%
   root text, page width reached 1990px. A font-relative container query selects
   the compact navigation; the same check now reports zero horizontal overflow.
   Menu open, Escape and content access are covered.
7. **Previous chapter tests disabled smooth scrolling.** Removed that override
   from the main journey test and added forward/reverse monotonicity, stable scene
   height, no repeated semantic writes, short viewport and enlarged-text checks.

## Motion and approved additions

- A: same EX-014 artifact, clearer receipt attachment and active-receipt emphasis.
- 7: native chapter navigation retained; current state follows actual position.
- 8: compact chapter pacing retained; scene dimensions remain stable.
- 9: current dashboard screenshots retained; a bounded composition entrance now
  introduces the primary dashboard and supporting windows when visible. Native
  preview focus/close behavior remains tested. Stable scrollbar gutters prevent
  page-width changes when preview scroll locking hides a classic scrollbar.
- 10: existing interruptible tab transitions and keyboard behavior remain tested.
- 11: added a bounded evidence-line highlight and EX-014 arrival in the hero card;
  primary copy/actions remain stationary. Existing copy/error feedback tested.
- 12: existing theme transition and paired dashboard images remain tested.
- 13: report uses a deliberate mask/opacity entrance with reserved layout space.

No animation library, wheel interception or perpetual animation was introduced.
Reduced motion, Save-Data, no-JS and short/mobile layouts retain readable records.
The example still says Detected and Insufficient evidence; animation changes no
verification claim.

## Files changed in this follow-up

- `apps/marketing/src/components/landing/EvidenceWorld.astro`
- `apps/marketing/src/components/landing/evidence-journey.ts`
- `apps/marketing/src/components/landing/PremiumHero.astro`
- `apps/marketing/src/components/landing/HeroProductFrame.astro`
- New `apps/marketing/src/components/landing/landing-effects.ts`
- `apps/marketing/src/components/Header.astro`
- `apps/marketing/src/styles/global.css`
- `apps/marketing/tests-browser/marketing-evidence-motion.e2e.ts`

## Verification

- Marketing unit suite: 535 passed, 59 files.
- Browser suites: 73 passed, including previous marketing audit regressions.
- Astro check: 0 errors, 0 warnings; one existing Myra hint.
- Marketing lint, targeted Prettier and git diff checks passed.
- Production build passed with 274 prerendered HTML files passing CSP validation.
- Batched rendered inspection covered desktop dark/light and mobile; final
  confirmation checked the corrected scene and mobile layout.
- Local headed Chromium frame sample during native smooth navigation: 192 sampled
  intervals, median 8.3ms, p95 9.2ms, zero intervals above 33ms. This is a local
  animation-frame scheduling sample, not a production Core Web Vitals score or
  proof of compositor performance on other hardware.

Evidence is under `output/playwright/evidence-motion/`: review-before.png,
review-final-desktop.png, review-final-mobile.png, and motion-review-*.log.

Safari, Firefox, physical phones and production account/provider flows were not
verified. Existing local Myra/account CSP errors remain environment-specific.
All work remains local and uncommitted; unrelated dashboard changes were preserved.
