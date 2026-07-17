# LyraShield assurance-world motion workspace

This private workspace produces the deterministic Three.js evidence world. It is production tooling only; the Astro site consumes rendered posters and clips and does not import Three.js, GSAP, Vite, or HyperFrames.

## Local pipeline

From the repository root:

```bash
# Bundle both compositions
pnpm --filter @lyrashield/marketing-motion build

# HyperFrames runtime, layout, motion, contrast, and timeline checks
pnpm --filter @lyrashield/marketing-motion check
pnpm --filter @lyrashield/marketing-motion inspect

# Captioned desktop/portrait masters and geometry-only website masters
pnpm --filter @lyrashield/marketing-motion render
pnpm --filter @lyrashield/marketing-motion render:web

# Render the software-backed checksum compositions twice and prove selected source frames are deterministic
pnpm --filter @lyrashield/marketing-motion render:determinism
pnpm --filter @lyrashield/marketing-motion verify:determinism

# Derive seven MP4/WebM chapters, AVIF/WebP/JPEG posters, and launch edits
pnpm --filter @lyrashield/marketing-motion derive

# Validate masters, codecs, dimensions, fps, GOP, pixel format, faststart,
# silence, budgets, exact boundary frames, and decoded seam SSIM
pnpm --filter @lyrashield/marketing-motion verify

# Copy web assets into the ignored localhost media directory
pnpm --filter @lyrashield/marketing-motion prepare:local

# Build and run the production-shaped Worker preview on localhost:8787
pnpm --filter @lyrashield/marketing preview
```

Review `http://localhost:8787/premium-preview`. Local masters remain under ignored `renders/`; browser media remains under ignored `apps/marketing/public/media-local/`.

## Production publication gate

The R2 command is intentionally locked and refuses an existing immutable object. Do not run it until the founder explicitly finalizes the localhost preview and the bucket/domain/CORS gate is ready:

```bash
pnpm --filter @lyrashield/marketing-motion publish:r2 -- --confirm-production
```

No production upload, DNS change, homepage promotion, merge, or Cloudflare deployment is part of the local pipeline.
