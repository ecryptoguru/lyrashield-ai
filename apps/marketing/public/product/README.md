# Product screenshots

These are real captures of the LyraShield evidence console, used on the marketing
homepage. They are **redacted at the file level** before they enter the repo.

| File | Used by | Route captured |
| --- | --- | --- |
| `console-home.webp` | `landing/HeroProductFrame.astro` | `/dashboard` |
| `console-trust-runs.webp` | `landing/V2Launch.astro` | `/trust-runs` |
| `console-issues.webp` | `landing/AssuranceRecord.astro` | `/issues` |
| `console-coding-agents.webp` | `landing/WhereYouWork.astro` | `/coding-agents` |

## The redaction rule

Anything below is destroyed in the image itself — pixelated down and then
blurred, so the original glyphs are gone from the bytes we ship:

- Account identity: real names, email addresses, avatars.
- Repository coordinates: `owner/repo` strings, target display names that match a
  private repo.
- Source file paths and line numbers.
- Finding titles, endpoint names, mutation names, and any other text that
  describes how to exploit a specific unfixed issue.

What deliberately stays visible: severity pills, evidence states, CWE and CVSS
references, run types, timestamps, counts, and every piece of product chrome.
That is the shape we want to show; the specifics are what we owe discretion.

**Never redact with CSS, an overlay box, or a flat fill.** A `filter: blur()` is
undone by disabling a stylesheet, and a solid box over selectable text still
ships the text. Anyone can open these files directly from `/product/…`.

## Regenerating

`redact_shots.py` (kept out of the repo, in the agent workspace) holds the region
map for the current captures. For a new capture, re-derive the regions: crop the
region, downsample it to a handful of pixels, upsample with nearest-neighbour,
then Gaussian-blur, and paste it back. Export WebP at quality 82, 1600px wide for
the hero and 1400px for the in-page shots.

## Before adding a new shot

1. Capture from a workspace whose targets you are willing to name publicly.
   A demo workspace beats redaction.
2. Redact per the rule above, then **open the exported file and read it** at full
   size. Half-blurred sentences are worse than none — they read as careless.
3. Keep `width`/`height` accurate on the `<img>`; the page is tuned for zero
   layout shift.
4. Write a caption that says what the frame proves, and disclose what was blurred.

## Guardrail

Captions must not imply a capture shows more than it does, and must not present
sample or demo data as production metrics. If a frame shows an unfixed issue in
one of our own products, blur the specifics — a marketing page is not a
disclosure channel.
