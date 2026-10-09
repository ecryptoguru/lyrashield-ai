# Product screenshots

The current marketing previews use the founder-supplied dashboard captures from
October 9, 2026. These are actual captures of the demo workspace, with matching
dark and light views. They replace the earlier synthetic component fixtures.
Counts and evidence states describe the captured example, not product-wide
performance or a claim of readiness.

The homepage presents one readable view at a time: Overview, Findings, Scan
record, Launch readiness and Coding agents. The selected view follows the page
theme; Expand preview opens the same image at a readable size. Without
JavaScript, all five captioned views remain available. Methodology uses the
same paired scan and finding captures.

## Sources and preparation

Original files remain outside the repository. Filenames below are relative to
the founder's screenshot directory; none of the original screenshots are
published. Image coordinates are in the original 3024 × 1964 capture.

| Asset pair        | Dark source time | Light source time | Crop: x, y, width, height | Export     |
| ----------------- | ---------------- | ----------------- | ------------------------- | ---------- |
| current-posture   | 11.28.28 PM      | 11.34.17 PM       | 600, 100, 2424, 905       | 1600 × 597 |
| current-findings  | 11.30.50 PM      | 11.33.40 PM       | 2000, 66, 1024, 890       | 960 × 834  |
| current-scan      | 11.34.07 PM      | 11.34.00 PM       | 600, 130, 2424, 970       | 1600 × 640 |
| current-readiness | 11.31.31 PM      | 11.33.15 PM       | 600, 100, 2424, 915       | 1600 × 604 |
| current-agents    | 11.31.57 PM      | 11.33.06 PM       | 600, 100, 2424, 1045      | 1600 × 690 |

Source names use the format Screenshot 2026-10-09 at TIME.png. Export WebP at
quality 82. Both themes use identical crop coordinates and export dimensions.
Preserve actual screenshot pixels and UI text; do not generate or reconstruct
the dashboard through an image model.

The two Technical-tab captures (11.30.57 PM and 11.33.47 PM) are deliberately
not published: their dense issue-specific details add disclosure risk while
contributing less to an overview than the finding's evidence state and action.

## Privacy at the file level

Crop away the sidebar, account name, email and browser framing. The captures
keep the demo-workspace label, UI controls, semantic states and counts.

Before cropping and resizing, destroy these source-coordinate regions by
downsampling each to 6 × 2 pixels, scaling back with nearest-neighbor sampling
and applying a 15px Gaussian blur:

| Asset            | Regions: x, y, width, height                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| current-posture  | 2170, 935, 760, 58 — private evaluated-review identity                        |
| current-findings | 2165, 100, 760, 52; 2040, 166, 940, 57 — private finding title and breadcrumb |
| current-scan     | 636, 308, 230, 48; 790, 614, 225, 48 — private target identity                |

The other crops contain no account identity, repository coordinates or finding
specifics. Never ship an original and rely on CSS, an overlay or a flat fill to
conceal its contents. Public image URLs must be safe to open directly.

Each exported WebP has a companion JSON record with its source and preparation provenance. After
regeneration, inspect both themes at full size and verify their dimensions,
redaction and UI readability. Keep factual alt text and captions aligned with
the content actually included in the crop.

## Legacy assets

The console-*.webp files predate these captures. They are retained as historical
assets and are no longer referenced by the homepage or methodology. Do not
reuse them as current dashboard UI or copy their old route names into captions.
