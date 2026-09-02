# WebMCP Demo — HyperFrames Production Plan

## Purpose

Produce a 16:9, 1920×1080, 165-second maximum explainer from real LyraShield captures. HyperFrames supplies only title cards, transitions, captions, and evidence callouts; it must not invent product screens, native-tool activity, dashboard receipts, or security results.

Use the existing visual identity in `apps/marketing-motion/DESIGN.md`:

- canvas `#08111c`; structure `#0e1a28`; signal `#54d6df`;
- proof `#5cdb95`; caution `#f5b84b`; failure `#ff7168`;
- statement type: Bricolage Grotesque Variable 800; evidence type: JetBrains Mono Variable 350–600.

## HyperFrames composition structure

Create one root `index.html` composition at 1920×1080 with seven external scene compositions. Use CSS focus-pull or blur-crossfade transitions at 0.4–0.6 seconds; do not use jump cuts, neon grids, glitches, or generated dashboards.

| Scene | Duration | Real footage required | HyperFrames overlay |
| --- | ---: | --- | --- |
| Opening problem | 0:00–0:12 | Lab title or `/webmcp` pillar | “Review WebMCP tools before they reach production.” |
| Native proof | 0:12–0:35 | Headed supported-client tool list and one real invocation | Tool name, bounded-result label, visible activity receipt. Omit until real native capture exists. |
| Browser-local analysis | 0:35–1:00 | Security Lab unsafe sample and evidence states | “Local analysis · nothing uploaded” and the observed state count. |
| Bounded rewrite | 1:00–1:28 | `WEBMCP-03` selection and visible diff | Mono diff callout: `exposedTo: ["*"]` to `exposedTo: []`. |
| Rerun and undo | 1:28–1:45 | Apply in memory, rerun, Undo | “Review required. No repository change.” |
| Repository gate | 1:45–2:05 | Public GitHub repo, MIT license, and relevant green CI | “Source scan · SARIF · fail-closed gate.” |
| Human boundary | 2:05–2:28 | Ordinary judge dashboard proof, only if captured | “Agent prepares. Human starts.” Use `/webmcp` limitation page instead when unavailable. |
| Limits and close | 2:28–2:45 | Pillar/control page | “Deterministic detection is not verification.” |

## Tracks and media contract

- Track 0: matte `#08111c` scene backgrounds and real screen recordings.
- Track 1: captured browser video clips, always visible behind overlays.
- Track 2: evidence captions, labels, and restrained cyan signal-line transitions.
- Track 3: one narration audio file. No music, third-party audio, customer source, credentials, or private URLs.
- Every captured video element is `muted playsinline`; narration is a separate audio element.
- Each scene registers a paused GSAP timeline in `window.__timelines`; composition duration comes from `data-duration`.

## Motion direction

Build each scene’s readable end-state first. Then animate every label into place with varied `gsap.from()` entrances: statement from 32px vertical offset, evidence count from 20px horizontal offset, and source label from 0.95 scale. Use `power3.out`, `power2.out`, and `sine.out` within a scene. Keep outgoing content visible until the focus-pull transition starts. Only the closing scene fades to black.

Caption treatment: high-contrast foreground `#edf6fb`, muted supporting text `#91a7b8`, evidence states in their semantic colors, minimum 20px body and 60px display type. Use tabular numerals for control counts. Keep every phrase on screen long enough to read twice; do not force line breaks into responsive text.

## Capture and edit gates

1. Capture public Lab footage from the live site, including privacy note, unsafe result, bounded diff, Apply, rerun, and Undo.
2. Capture one real native WebMCP invocation in a headed supported client before using the Native proof scene. Brave lacks `document.modelContext` in the verified session, so it cannot supply that evidence.
3. Capture dashboard footage only with an ordinary isolated judge account; verify cross-workspace denial before recording.
4. Run `hyperframes lint`, `hyperframes validate`, visual inspection, and animation-map review once a composition exists. Correct contrast, collisions, pacing, and overflow before export.
5. Verify final media locally: under 180 seconds, 1080p, narration audio present, no secrets/private URLs, and every on-screen claim matches exact capture evidence.
6. Leave publication and Devpost submission out of scope for this plan.

## Asset manifest

- `capture-lab-unsafe.mp4`: real Lab unsafe-sample result.
- `capture-lab-rewrite.mp4`: real `WEBMCP-03` prepare, Apply, rerun, and Undo sequence.
- `capture-native-tool.mp4`: required before the Native proof scene is enabled.
- `capture-repo-ci.mp4`: public repository, MIT license, and exact green CI evidence.
- `capture-dashboard-judge.mp4`: optional until ordinary-account proof exists.
- `narration.wav`: one factual human-recorded or approved TTS narration.
- `captions.vtt`: captions generated only from the approved final narration.

No asset may be replaced with a generated simulation. Missing proof removes its scene or uses the documented public fallback.

Use [webmcp-demo-narration.md](webmcp-demo-narration.md) for the factual narration and provisional caption cues. Replace its times only after the final narration exists.
