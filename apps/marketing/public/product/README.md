# Product screenshots

These are real captures of the LyraShield evidence console. They are **redacted at
the file level** before they enter the repo.

- `console-home.webp` — captured at `/dashboard`, used full-width by
  `components/landing/HeroProductFrame.astro` as the large frame in the hero
  collage.
- `console-trust-runs.webp` — captured at `/trust-runs`, used full-width by
  `pages/methodology.astro` under "What every new scan record preserves".
- `console-issues.webp` — captured at `/issues`, used full-width by
  `pages/methodology.astro` under "Evidence states are not interchangeable".
- `console-coding-agents.webp` — captured at `/coding-agents`, used full-width
  by `pages/docs/integrations/index.astro` under "Fastest path: the CLI".
- `console-issues-thumb.webp`, `console-coding-agents-thumb.webp` — the
  matching captures with the app sidebar cropped off (see "Thumbnail crop"
  below). Used only by `HeroProductFrame.astro`, as the two small frames
  stacked beside the dashboard view in the hero collage. There is
  deliberately no `console-trust-runs-thumb.webp`: Trust Runs was cut from the
  collage so the remaining two frames could run taller. If it comes back,
  regenerate its thumb from `console-trust-runs.webp` rather than assuming a
  stale copy is lying around.

The hero uses its own frame component; everything else goes through
`components/ProductShot.astro`, which supplies the browser chrome and caption.

## Thumbnail crop

The `*-thumb.webp` files are cropped from the corresponding full capture: the
app's left sidebar (0 to x=267 in the original 1400px-wide export) is removed,
leaving a 1133×883 image of just the content pane. At hero-thumbnail size the
sidebar was mostly wasted width; the content is what makes each frame's point.

**This is a separate file, not an edit of the shared original.** The full
1400×883 captures stay untouched because `pages/methodology.astro` and
`pages/docs/integrations/index.astro` render them full-width, sidebar
included, at a size where the sidebar reads fine. If you need to redo a crop,
verify the sidebar/content border position first — do not assume x=267 holds
for a differently-styled future capture:

```python
from PIL import Image
im = Image.open("console-x.webp").convert("RGB")
prev = None
for x in range(200, 320):
    px = im.getpixel((x, 400))
    if prev and sum(abs(a - b) for a, b in zip(px, prev)) > 15:
        print(x, prev, "->", px)
    prev = px
```
Look for a consistent edge across several `y` values before picking the crop
`x`; a single sampled row can catch a card border instead of the sidebar edge.

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
