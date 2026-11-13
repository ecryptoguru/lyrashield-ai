# Homepage plan: fewer words, stronger visuals

Status: implemented and approved for release after localhost review on October 29, 2026. Existing product truth, shared copy and release rules still apply.

## Objective and baseline

Help an AI app builder understand the product and choose Start free trial through
one visual story: target, findings, approval, retest and report.

A read-only inspection of the current public page at 1440 × 900 counted roughly
1,322 expanded words inside main, excluding pricing, navigation, hidden panels and
closed disclosure answers. This includes rendered labels and required disclosures.
The count is an approximate DOM measurement, not an editorial count of every
possible interaction state. Use the same counting method before and after.

Target at most 550 expanded words under that definition: approximately 60% fewer.
Required consent, trial terms, validation and material limitations take precedence
over a section's suggested budget. Do not shrink fonts to achieve the target.

## Visual and content direction

Retain navy/cyan, the existing typefaces, both themes and the cinematic world.
Use actual redacted product captures, restrained line diagrams and concise labels.
Give each section one question to answer and one dominant visual. Avoid replacing
paragraphs with dense icon cards, decorative dashboards or another autoplay video.

The main repetition today is evidence/approval/retest explanation across the hero,
differentiator grid, cinematic story, product preview, coverage and final CTA.
Explain the workflow once; let later sections show the product or answer a new question.

## Section plan

| Existing area                          | Proposed treatment                                                                                                                                                                                        | Expanded word budget |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------: |
| Hero                                   | Keep the headline; use one short introduction, one proof line and the existing actions. Let the film dominate the scene window. Move the URL form to the Lite Check section.                              |                55–65 |
| Differentiator grid and audience cards | Replace paragraph cards with a compact evidence-state graphic and approval indicator. Keep methodology and agency/demo access as small links.                                                             |                20–25 |
| Lite Check explanation and sample      | Put the existing form here. Keep consent and all functional states. Use a three-row illustrative result with labels rather than explanatory paragraphs.                                                   |                70–90 |
| Seven-chapter cinema and example       | Each chapter gets a short heading and one sentence. Keep one illustrative finding that progresses through approval and an inconclusive retest. Remove repeated receipts and supporting-card explanations. |              180–210 |
| Product preview, surfaces and coverage | Consolidate into the real product preview with manual view tabs, one short caption and a small labeled integration rail. Link detailed coverage instead of repeating its documentation.                   |                45–65 |
| Pricing                                | Retain shared prices, meaningful capacity limits and necessary terms. Remove repeated audience paragraphs; link full comparison.                                                                          |     Count separately |
| FAQ                                    | Four questions, with concise answers collapsed by default. Move specialist topics to their existing pages.                                                                                                |  25–40 for questions |
| Final CTA                              | One short heading, Start free trial and the required shared trial disclosure. Remove the repeated onboarding paragraph and step list.                                                                     |                25–35 |

Budgets are provisional; test actual shared disclosures before locking final copy.

### Proposed hero copy

**The launch gate for AI-built apps.**

Review your repo, website or API. Approve proposed fixes and retest before you ship.

**Evidence attached. Fixes need approval.**

Primary: **Start free trial**. Secondary: **See the workflow**.
Retain the current signup attribution and required trial disclosure. The separate
Lite Check form keeps its authorization statement and existing validation behavior.

### Proposed cinematic copy and visual roles

| Chapter  | Heading                  | One-sentence explanation                                                             | Visual role                                            |
| -------- | ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Gateway  | From target to report.   | Keep your review, proposed fixes and retest results together.                        | One connected workflow line                            |
| Target   | Set the scope.           | Choose a repository, website or API you are authorized to test.                      | Three labeled target types                             |
| Scan     | See the findings.        | Coverage shows which checks ran and where assessment was limited.                    | Finding and coverage markers                           |
| Evidence | See what is supported.   | Detected, retest-confirmed and inconclusive results stay distinct.                   | Three labeled evidence states                          |
| Approval | Review the proposed fix. | You approve the proposal. Nothing auto-merges.                                       | Approval boundary on the sample patch                  |
| Retest   | Check the change again.  | Complete deterministic coverage can confirm a fix; missing proof stays inconclusive. | An honest inconclusive result for the existing example |
| Report   | Share the result.        | Bring scope, findings, retest outcomes and limitations into one report.              | One report artifact                                    |

Use the existing example's real narrative constraints. Do not animate an
inconclusive example into a confirmed fix merely to create a pleasing ending.

### Product visuals

- Reuse the existing redacted overview, findings, scan-record and readiness captures.
  Show one strong default view with manual selectors for the others.
- On desktop, use a large readable capture and at most three small annotations.
  On mobile, use an intentional crop with an accessible way to inspect the full view.
- Keep genuine capture labels such as Demo workspace. Label reconstructed
  diagrams and sample results Illustrative example.
- Use small SVG icons for repository/website/API and supported integrations,
  with text labels. These indicate compatibility, not customer endorsement.
- Keep provenance and evidence limits legible. Avoid fabricated findings,
  customer logos, performance counters, certifications or proof badges.

### FAQ and supporting destinations

Retain: account setup; what results prove; whether fixes require approval; and
Lite Check versus full review. Answers should lead with a direct sentence, then
add only a necessary qualification or relevant first-party link.

Detailed control coverage, the Evidence Vault, PHP support, WebMCP, integration
setup, specialist-scanner comparisons and privacy details remain available on
their existing pages. Keep useful contextual links; remove duplicate homepage
explanations rather than deleting access to those capabilities.

## Protect the verified motion

The primary goal is less reading, not less cinematic scroll distance.

- Preserve the buffered native player, original film bytes, quality, progress UI,
  byte limits, cleanup and motion preferences.
- Preserve all seven IDs and timeline boundaries, the mobile scene window and
  current chapter minimum heights. Do not repeat the earlier reduction from
  95svh to 58svh on mobile.
- Record chapter geometry at matched viewports before implementation. Text edits
  and relocated forms must not silently shorten the gateway band or later bands.
  Its geometry depends on the pre-story sections as well as chapter heights.
- Recompose existing cinematic space with useful visual content when consolidating
  copy. Avoid artificial empty spacer sections. Treat any unavoidable pacing change
  as a separate design decision requiring fresh motion acceptance.
- Supporting sections outside the cinematic world may become shorter. Do not set
  a page-height reduction quota that pressures the film mapping.
- Use existing CSS/native interactions for small reveals, focus and pressed states.
  Avoid new scroll libraries, decoder paths, large animated effects or additional films.

## Search, accessibility and performance

Keep the product definition, workflow, evidence distinctions and essential limits
in semantic server-rendered HTML. Visuals supplement that content. Do not put all
meaning into images, hide extra crawler copy or repeat keywords to compensate for
shorter text. Align FAQ schema and metadata with the final visible copy; preserve
canonical URLs and useful anchors. No ranking or AI-citation promises.

Use readable body type, meaningful alt text, text labels alongside state colors,
keyboard controls, 44px touch targets and reduced-motion/static fallbacks. Keep
real image dimensions, responsive image sources and lazy loading below the fold.
Reuse existing assets first; add no new large media payload for decorative variety.

## Delivery and approval sequence

1. Capture matched desktop/mobile screenshots, copy counts and chapter geometry.
2. Prepare the final short copy and a desktop/mobile composition showing which
   current visual replaces each removed paragraph. Review those locally first.
3. Implement copy and visual changes without altering the verified player. Update
   focused regressions for form placement, anchors, disclosure content and schema.
4. Verify 360, 390, 768, 1280 and 1440px, both themes, keyboard use, 200% text,
   reduced motion and no JavaScript. Check screenshot legibility and loading states.
5. Confirm the word target using the matched counting method, then rerun all 12
   actual-film performance cases with the approved buffered-start policy. Retain
   seek, frame-interval, LCP and CLS thresholds.
6. Present localhost before/after views for approval. After approval, use a focused
   PR, wait for its required checks, deploy and verify the public revision again.

Expected implementation areas: PremiumHero, HomeLiteScan, EvidenceWorld,
motion-manifest chapter copy, HeroProductFrame, homepage sections, FAQ content and
FinalCta. The motion controller and media pipeline are protected from this redesign.
