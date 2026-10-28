# Homepage design brief

Mode: Persuade. Target: `apps/marketing/src/pages/index.astro`.

## Direction

Preserve LyraShield AI's navy/cyan identity, Bricolage display face, Inter body
copy, light/dark themes and seven-stage scroll cinema. The primary task is to
understand the review workflow and start a trial. The cinematic architecture is
the focal visual; the actual console demonstrates the product.

The page follows hero → cinematic workflow → console → Lite Check → pricing →
four FAQs → closing trial action. Detailed coverage, agent setup and evidence
methodology remain available through explicit first-party links. Keep one
illustrative finding, labeled as an example, with a detected finding and an
inconclusive retest. Never present illustrative output as customer evidence.

## Typography and layout

The homepage intentionally uses a fluid display scale capped at 6rem, section
headings at 2–3.5rem, body text at 1–1.2rem and supporting controls and metadata
at .8–.95rem. Tracking never exceeds -.04em. These surface-specific sizes extend
the existing design system; they do not change dashboard typography.

Use generous section separation, compact related content, fewer boxed groups,
and opaque or sufficiently protected reading surfaces. Keep the primary trial
CTA in the first 390 × 844 viewport. The dedicated Lite Check retains its
consent, unavailable state and private URL handoff. Prices and limits come from
the shared catalog.

## Motion thesis

- Focal moment: one continuous architectural film follows native scrolling.
- Presentation: a paused decoder seeks toward the latest scroll position. Completed
  frames are copied to a canvas below the readability overlay. Keep the previous
  frame visible during a seek; never use autoplay to advance the story.
- Mobile controls: chapter navigation has a separate sticky row below the motion
  toggle so enlarged text does not collapse navigation or cover its links.
- Continuity: chapter navigation follows presented frames, with a stable example
  accumulating scope and review context without upgrading its evidence state.
- Feedback: brief button and link states, native FAQ disclosure feedback, product
  view selection and one console arrival. Critical text is visible by default.
- Budget: one decoder, one pending seek, coalesced scroll requests, cached geometry,
  and no offscreen or hidden-tab playback. No runtime 3D or new animation library.
- Accessibility: reduced motion and Save-Data keep a complete poster/text
  experience. A failed video never blocks reading, navigation or form controls.

## Content and search

Keep a concise explanation of the product, audience, authorized targets, human
approval and retest limits in server-rendered HTML. FAQs and structured data
share one source. The homepage editorial date also drives sitemap freshness.
Do not add hidden SEO copy or claim guaranteed indexing, rankings or AI citations.

## Release gate

This redesign requires explicit approval after localhost live testing before
merge, media publication or deployment. Automated tests and screenshots alone
are not the founder's approval. Physical-device and field performance need
separate evidence.
