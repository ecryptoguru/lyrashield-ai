# LyraShield AI — 3-minute OpenAI Build Week narration master

**Final runtime target:** 2:55–3:00.

**Generated narration audio:** 2:46.656 (use compressed scan visuals and end-card hold to fill to target length).

**Language:** English.

**Recording checklist:** `docs/devpost/video/RECORDING.md`
**Visual storyboard:** `docs/devpost/video/STORYBOARD.md`
**Caption draft:** `artifacts/devpost-video/captions-draft.srt`
**Caption source of truth:** `artifacts/devpost-video/captions-final.srt` (retimed from actual Deepgram audio)
**Caption actual timings:** `artifacts/devpost-video/captions-actual.srt`
**Combined narration audio:** `artifacts/devpost-video/narration-full.mp3`
**Deepgram narration input:** `artifacts/devpost-video/narration.json`
**Deepgram narration script:** `scripts/deepgram-narration.mjs`
**Caption retiming script:** `scripts/retime-captions.mjs`
**Voiceover:** AI-generated via Deepgram.

## 00:00–00:12 — Hook

AI-built software can reach production before anyone can answer a basic question: what was actually tested? LyraShield AI turns that uncertainty into an evidence-backed release decision.

## 00:12–00:50 — Live Lite Check with compressed wait

This is the live product. From the public site I can run a passive, read-only Lite Check without signing up. It only reads what the app already sends to any visitor — exposed secret patterns, browser protections, public data-layer signals, and HTTPS. The scan itself takes about ten minutes. Here is the actual wait compressed so we can see the result.

## 00:50–01:14 — Result detail and illustrated issues and fixes

For LyraShield's own site, the surface check came back clean: zero need attention, zero worth reviewing, and five checks look okay. But the limitation stays on screen — a clean public scan is useful evidence, not a security guarantee. When there is an issue, the product separates a detected candidate from independent verification, approval-bound fix proposals, retest outcomes, and retained uncertainty. The sample report is visibly marked as a sanitized mock.

## 01:14–01:34 — Evidence methodology

That distinction drives the entire methodology. Detection, verification, retest, and inconclusive evidence are separate facts. LyraShield does not claim universal security or automatic fixes.

## 01:34–01:58 — Authenticated workspace

Inside the authenticated workspace, I configured LyraShield's public site as a target. Notice the dashboard says Needs evidence and leaves the score blank. The product never turns an unrun scan into a confident number.

## 01:58–02:20 — Controlled scan setup

The scan setup exposes Release Check, Code Review, and Deep Security Review. I do not start a full scan in this demo. That path is separately authorized, budget-bounded, and admitted only when a healthy worker is available.

## 02:20–02:48 — Build Week and GPT-5.6 proof

The architecture keeps public URL checks deterministic and repository reviews behind a controlled GPT-5.6 runtime. The worker routes focused work to Luna and deep coordination to Terra, both at medium reasoning with bounded delegation. During Build Week, GPT-5.6-powered Codex sessions traced cross-package flows, implemented evidence boundaries, diagnosed failures, reviewed the real UX, and hardened the release path. On this revision, 934 core tests, 80 marketing tests, 16 motion tests, and 4 Chromium end-to-end tests pass.

## 02:48–02:55 — Close

LyraShield AI does not promise that everything is secure. It shows what evidence exists, what remains uncertain, and whether an AI-built app is ready to ship.

## Pronunciation map

- LyraShield AI: “Lie-ra shield A I”
- GPT-5.6: “G P T five point six"
- HTTPS: “H T T P S"
- Luna and Terra: pronounce as ordinary English names.

## Deepgram generation notes

- Use the cleaned narration sections in `artifacts/devpost-video/narration.json`.
- Run `node scripts/deepgram-narration.mjs` to generate audio files.
- Each numbered section becomes a separate WAV/MP3 file so timings can be adjusted in edit.
- Preferred voice: calm, professional, slightly technical, native or near-native English.
- Recommended settings: 24 kHz, WAV or high-bitrate MP3, normal speaking pace (do not speed up).
- Review each export for correct pronunciation of LyraShield, GPT-5.6, Luna, Terra, HTTPS.
