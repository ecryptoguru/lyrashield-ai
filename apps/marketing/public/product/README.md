# Homepage hero product image

`dashboard-placeholder.svg` is a deliberate placeholder, not a screenshot. It is rendered by
`src/components/landing/PremiumHero.astro` inside a real `<figure>` so the slot is crawlable and
accessible today, and so the real capture is a one-file swap later.

## Swapping in the real screenshot

1. Capture the release-record view at **1600×1000** (or any 8:5 image; the frame is aspect-locked,
   so a different ratio will letterbox rather than distort). Capture at 2× and export at 1600px wide
   for a crisp result on retina displays.
2. Scrub it before it goes anywhere near this repo: no real repo names or URLs, no customer or
   account names, no email addresses, no tokens or key fragments, no internal IDs you would not put
   on a billboard. Prefer a demo workspace over redaction boxes.
3. Save it here as `dashboard.webp` (WebP or AVIF preferred; PNG is acceptable).
4. In `PremiumHero.astro`, change `heroProductImage` to `/product/dashboard.webp`, set
   `heroProductIsPlaceholder` to `false`, and update `heroProductAlt` to describe what the capture
   actually shows.
5. Rewrite the `figcaption` so it stops saying "placeholder" and instead names the view, e.g.
   "The release record view: findings grouped by evidence state, with retest outcomes."

Leave the `<figure>`/`<figcaption>` structure and the explicit `width`/`height` in place — they
prevent layout shift and keep the image crawlable and captioned for answer engines.

## Guardrail

Until a real capture lands, the caption must keep saying the image is an illustrative placeholder.
Shipping a mock that reads as a real product screenshot is exactly the kind of claim the LyraShield
copy rules exist to prevent.
