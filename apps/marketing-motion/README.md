# LyraShield assurance-world motion workspace

This private workspace produces the deterministic 56-second, seven-chapter Three.js evidence world (media version 3). It is production tooling only; the Astro site consumes rendered posters and clips and does not import Three.js, GSAP, Vite, or HyperFrames.

## Local pipeline

From the repository root:

The `derive`, `verify`, and `verify:determinism` commands require `ffmpeg` and `ffprobe` on `PATH`. They are system tools and are not installed by pnpm.

```bash
# Bundle both compositions
pnpm --filter @lyrashield/marketing-motion build

# HyperFrames runtime, layout, motion, contrast, and timeline checks
pnpm --filter @lyrashield/marketing-motion check

# After draft review and approval: desktop/portrait masters and website masters
pnpm --filter @lyrashield/marketing-motion render
pnpm --filter @lyrashield/marketing-motion render:web

# Render the software-backed checksum compositions twice and prove selected source frames are deterministic
pnpm --filter @lyrashield/marketing-motion render:determinism
pnpm --filter @lyrashield/marketing-motion verify:determinism

# Derive one continuous H.264 track per aspect ratio, AVIF/WebP/JPEG posters,
# and short launch edits
pnpm --filter @lyrashield/marketing-motion derive

# Validate masters, codecs, dimensions, fps, GOP, pixel format, faststart,
# silence, budgets, chapter poster frames, and two-frame desktop and four-frame portrait GOPs
pnpm --filter @lyrashield/marketing-motion verify

# Copy web assets into the ignored localhost media directory
pnpm --filter @lyrashield/marketing-motion prepare:local

# Build and run the production-shaped Worker preview on localhost:8787
pnpm --filter @lyrashield/marketing preview:build
pnpm --filter @lyrashield/marketing preview:motion
```

The motion preview adds range-capable local video delivery to the production-shaped Worker. Ordinary Wrangler local static assets ignore Range; production media uses the separate media origin. Review `http://127.0.0.1:8787/`. Local masters remain under ignored `renders/`; browser media remains under ignored `apps/marketing/public/media-local/`.

## Production publication gate

The R2 command is intentionally locked and refuses an existing immutable object. Do not run it until the founder explicitly finalizes the localhost preview and the bucket/domain/CORS gate is ready:

```bash
pnpm --filter @lyrashield/marketing-motion publish:r2 -- --confirm-production
```

No production upload, DNS change, homepage promotion, merge, or Cloudflare deployment is part of the local pipeline.

The approved brighter desktop and portrait films were finalized on October 10, 2026. Web delivery uses 1440×810 / CRF 28 / two-frame GOP for desktop and 720×1280 / CRF 24 / four-frame GOP for portrait, within the 16 MiB and 10 MiB budgets. Native masters retain 1920×1080 and 1080×1920 resolution. The current canvas-only compositions have identical native and website pixels, so this release derives both web tracks from the full-resolution native masters.

Release media lives at `https://media.lyrashieldai.com/assurance-world/v3/74787c7fe35196b2/`. Codec, GOP, duration, silence, faststart, byte-budget and poster checks passed; two software renders per aspect ratio produced matching sampled source-frame hashes. Browser evidence includes 24 WebKit desktop/iPhone-sized checks, 12 actual-film Chromium performance checks, and a native macOS Safari smoke covering frame presentation, forward/reverse chapter navigation and the motion toggle. A physical iPhone was not tested. HyperFrames remains pinned to `0.7.107`; a renderer update must pass composition checks and rendered-frame verification before it is retained.
