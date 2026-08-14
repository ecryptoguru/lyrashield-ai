# Product screenshots

These are real captures of the LyraShield evidence console. They are **redacted at
the file level** before they enter the repo.

| File | Used by | Route captured |
| --- | --- | --- |
| `console-home.webp` | `components/landing/HeroProductFrame.astro` | `/dashboard` |
| `console-trust-runs.webp` | `pages/methodology.astro` | `/trust-runs` |
| `console-issues.webp` | `pages/methodology.astro` | `/issues` |
| `console-coding-agents.webp` | `pages/docs/integrations/index.astro` | `/coding-agents` |

The hero uses its own frame component; everything else goes through
`components/ProductShot.astro`, which supplies the browser chrome and caption.

## The redaction rule

Anything below is destroyed in the image itself — pixelated down and then
blurred, so the original glyphs are gone from the bytes we ship:

- Account identity: real names, email addresses, avatars.
- Repository coordinates: `owner/repo` strings, and target display names that
  match a private repo.
- Source file paths and line numbers.
- Finding titles, endpoint names, mutation names, and any other text describing
  how to exploit a specific unfixed issue.

What deliberately stays visible: severity pills, evidence states, CWE and CVSS
references, run types, timestamps, counts, and every piece of product chrome.
That is the shape worth showing; the specifics are what we owe discretion.

**Never redact with CSS, an overlay box, or a flat fill.** A `filter: blur()` is
undone by disabling a stylesheet, and a solid box over selectable text still
ships the text. These files are directly reachable at `/product/*.webp`.

## Method

Per region: crop it, downsample to a handful of pixels, upsample with
nearest-neighbour, Gaussian-blur the result, paste it back. Export WebP at
quality 82 — 1600px wide for the hero, 1400px for in-page shots.

## Before adding a new shot

1. Capture from a workspace whose targets you are willing to name publicly. A
   demo workspace beats redaction.
2. Redact per the rule above, then **open the exported file and read it** at full
   size. Half-blurred sentences are worse than none — they read as careless.
3. Keep `width`/`height` accurate on the `<img>`; these pages are tuned for zero
   layout shift.
4. Write a caption that says what the frame proves, and disclose what was blurred.

## Guardrail

Captions must not imply a capture shows more than it does, and must not present
demo data as production metrics. If a frame shows an unfixed issue in one of our
own products, blur the specifics — a marketing page is not a disclosure channel.
