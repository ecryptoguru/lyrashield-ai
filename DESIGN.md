---
version: alpha
name: LyraShield AI
description: Evidence-backed release assurance — terminal-precise, dark-first visual language.
colors:
  bg-dark: "#08111c"
  bg-raised-dark: "#0e1a28"
  border-dark: "#203246"
  text-dark: "#edf6fb"
  text-muted-dark: "#91a7b8"
  accent-dark: "#54d6df"
  accent-dim-dark: "#153d48"
  bg-light: "#f5f9fc"
  bg-raised-light: "#ffffff"
  border-light: "#d9e4ec"
  text-light: "#102235"
  text-muted-light: "#5f7081"
  accent-light: "#087f78"
  accent-dim-light: "#ccebe7"
  danger-dark: "#ff7168"
  danger-light: "#e5534b"
  amber: "#f3b95f"
typography:
  display:
    fontFamily: Bricolage Grotesque Variable
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: -0.055em
  body:
    fontFamily: Inter Variable
    fontSize: 16px
    lineHeight: 1.65
  mono-label:
    fontFamily: JetBrains Mono Variable
    fontSize: 12px
    fontWeight: 600
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  md: 0.5rem
  lg: 0.75rem
  xl: 1rem
  "2xl": 1.25rem
spacing:
  section-gap: clamp(3rem, 7vw, 7rem)
  container-max: 1280px
components:
  hero-primary-cta:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.bg-dark}"
    rounded: "{rounded.sm}"
    padding: 0.85rem 1.25rem
  hero-secondary-cta:
    backgroundColor: "rgba(8, 17, 28, 0.62)"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.sm}"
    padding: 0.85rem 1.25rem
  artifact-card:
    backgroundColor: "rgba(8, 17, 28, 0.82)"
    rounded: "{rounded.sm}"
    padding: 1.1rem 1.25rem
---

# LyraShield AI

## Overview

LyraShield is an evidence-backed release-assurance product for AI-built software.
The visual language is **terminal-precise and evidence-first**: dark surfaces,
a single cyan accent, mono-font labels for machine-readable states, and honest
empty/negative states rendered as plainly as passes. Nothing glows that isn't
true. Both dark and light themes are first-class; every surface must resolve
tokens under both `:root` and `:root[data-theme="light"]`.

Audience: builders who already distrust scanners. The design earns trust by
showing scope, evidence state, and limits — never by decoration.

## Colors

- Dark-first: `--bg #08111c`, raised `#0e1a28`, border `#203246`, text `#edf6fb`,
  muted `#91a7b8`. Light theme: `--bg #f5f9fc`, raised `#ffffff`, text `#102235`,
  muted `#5f7081`.
- Single accent: cyan `#54d6df` (dark) / `#087f78` (light). Accent-dim for
  tinted fills only.
- Semantic: danger `#ff7168`/`#e5534b`; warning/amber `#f3b95f`. Success uses
  the shared `success` token in `@lyrashield/ui`.
- **Purple/violet hues are banned.** Gradients stay cyan/teal or neutral.

## Typography

- Display: Bricolage Grotesque Variable, extrabold, tight tracking — hero
  headlines only.
- UI/body: Inter Variable.
- Machine/state labels: JetBrains Mono Variable, uppercase, letter-spaced —
  evidence states, statuses, eyebrows, artifact metadata.

## Layout

- Container max 1280px, `px-4 sm:px-6 lg:px-8`.
- Hero min-height `min(720px, calc(100svh - 3.5rem))`; mobile keeps the account
  action in the first viewport (ordered column, CTA before secondary links).
- Cinematic thresholds (`cinematic-threshold`) bridge dark↔light bands.

## Elevation & Depth

Subtle only: `box-shadow 0 1rem 3rem rgba(0,0,0,.28)` cards; cyan glow limited
to the accent dot (`0 0 14px`). No heavy drop shadows in light theme —
`rgba(39,75,94,.16)` range.

## Shapes

Squared-terminal aesthetic on the hero (radius `sm` 0.25rem); standard
`md`–`xl` radii elsewhere per shared UI. Focus ring: amber `#f5b84b`, offset 4px.

## Components

- **Hero CTAs:** primary = filled accent, dark text; secondary = translucent
  panel with accent border; tertiary = underlined accent text link. All
  `min-height ≥ 2.9rem`, focus-visible ring.
- **Artifact/evidence cards:** dark translucent panel, mono metadata rows,
  status shown honestly (`Detected`, never `Verified` for a synthetic example).
  Synthetic examples are always labeled "Example".
- **Flow/sample strips:** mono node labels, honest evidence states
  (Detected → approval-gated fix → Validated only where a retest ran).
- **Dashboard:** shared `@lyrashield/ui` components (Card, Badge, Button);
  `deriveHomeDecision` renders ONE next action — never two competing CTAs.
- **Failure surfaces:** structured `OperationFailurePresentation`
  (cause / effect / recovery + href), never raw error strings.

## Do's and Don'ts

- Do show limits and missing evidence visibly; don't round up to a pass.
- Do keep one primary action per surface; don't stack competing CTAs.
- Do label all synthetic/demo output "Example"; don't present mock data as
  verified or independently reviewed.
- Do honor `prefers-reduced-motion` and DNT/GPC; don't animate critical CTAs.
- Don't introduce purple/violet, glassmorphism-heavy layers, or emoji in UI.
- Don't change public copy claims (certification, guarantee, universal
  coverage) — see `docs/claims-policy.md`.
