# LyraShield AI — 3-minute OpenAI Build Week recording checklist

**Format:** 1920×1080, 30 fps, 16:9, stereo audio.  
**Target length:** 2:55–3:00.  
**Audio:** AI-generated via Deepgram (`scripts/deepgram-narration.mjs`).  
**Combined narration audio:** `artifacts/devpost-video/narration-full.mp3` (2:46.656).  
**Per-section audio:** `artifacts/devpost-video/audio/*.mp3`.  
**Captions:** `artifacts/devpost-video/captions-final.srt` (retimed to the actual audio).  
**Caption retiming script:** `scripts/retime-captions.mjs`.  
**Background music:** none (per `DESIGN.md`).  
**Capture rule:** every narration claim must be visible on screen when it is spoken.

## Pre-recording setup

- [ ] Close all non-essential browser tabs, bookmarks bar, extensions, and notifications.
- [ ] Set browser zoom to 100% and use a clean profile if possible.
- [ ] Record at 1440p or higher; downscale to 1080p in export for sharper text.
- [ ] Use a matte display or avoid glare; keep screen brightness consistent.
- [ ] Use a large, visible cursor and move it deliberately.
- [ ] Leave a lower safe area of ~10% for captions.
- [ ] Open `docs/devpost/video/STORYBOARD.md` on a second device as a shot reference.

## Public pages to capture (no login required)

### 1. Landing page — `https://lyrashieldai.com`

- Show the hero and tagline.
- Avoid scrolling too far; keep the hook line legible.
- Capture 5–8 seconds for the hook segment.

### 2. Lite Check form and full scan — `https://lyrashieldai.com` → `/scan?start=1`

- Enter `lyrashieldai.com` in the homepage form.
- Check the authorization box and click "Scan my app".
- Let the browser hand off to `/scan?start=1` automatically.
- Allow the full scan to run. It takes ~10 minutes.
- **Critical:** do not move the mouse or scroll during the wait. Static framing makes the speed-ramp honest and seamless.
- Capture the entire sequence in one continuous take from form submission to result reveal.
- Confirm result counts: `0` needs attention, `0` worth reviewing, `5` look OK.
- Keep the limitation text visible.
- Briefly show the scorecard/waitlist CTA at the bottom of the result page.

### 3. Sample report — `https://lyrashieldai.com/sample-report`

- Show the "Sanitized mock · not a real assessment" banner.
- Scroll slowly through all four cards.
- Keep the retained uncertainty visible.

### 4. Methodology page — `https://lyrashieldai.com/methodology`

- Scroll slowly through the five evidence states.
- End on the "What this methodology does not claim" section.

## Authenticated workspace to capture (login required)

Use `https://app.lyrashieldai.com`.

### 1. Dashboard overview

- Show the Launch verdict card with "Needs evidence" and blank score.
- Show the risk posture / score gauge in an "Awaiting completed scan" state.

### 2. Targets

- Show `lyrashieldai.com` configured as a public URL target.
- Highlight that it is a real configured target, not a synthetic demo target.

### 3. Scan setup

- Open the scan setup for the configured target.
- Show `Release Check`, `Code Review`, and `Deep Security Review` options.
- Show any authorization, budget, or healthy-worker gating language.
- Do **not** start the scan.

## Repository and Build Week evidence to capture (local or GitHub)

### 1. Architecture card

- Capture the repository-backed architecture summary from `README.md`, `ARCHITECTURE.md`, or a prepared slide.
- Highlight: deterministic public checks vs. controlled GPT-5.6 repository reviews.
- Optionally mention MCP / GitHub diff gate as supporting coverage layers.

### 2. Worker routing source

- Open `apps/worker/src/engine/runner.ts` at lines 187–199.
- Show the Luna/Terra routing and `reasoningEffort: "medium"`.

### 3. Current-revision verification card

- Run the test suite or show CI green status for the current revision.
- Capture the exact counts for the revision you are recording:
  - 934 core tests
  - 80 marketing tests
  - 16 motion tests
  - 4 Chromium end-to-end tests
- If the current counts differ from the script, update `SCRIPT.md`, `STORYBOARD.md`, `RECORDING.md`, and `captions-draft.srt` before recording.
- Capture the Codex task ID from the current build thread.

## End card

- Create or use the existing LyraShield AI end card with:
  - Tagline: evidence-backed release decisions.
  - Canonical domain: `lyrashieldai.com`.
  - No third-party logos, no stock footage.

## Fast-forward speed-ramp editing instructions

1. Keep the setup (form submit → first two scan rows) at 100% speed: ~14 seconds.
2. Isolate the long wait segment (~10 minutes of wall-clock footage).
3. Apply a 40–50× speed increase to compress it to ~12–15 seconds.
4. Add a lower-safe-area label: `Scanning · ~10 min compressed`.
5. Return to 100% speed the moment the `#results` panel appears.
6. Show the result details for 8–10 seconds.

## Recording order and target timings

| Segment | Target time | Source | Notes |
| --- | --- | --- | --- |
| Hook | 0:00–0:12 | Landing page | Slow focus pull |
| Lite Check setup | 0:12–0:26 | Homepage form + `/scan` | Normal speed |
| Compressed scan | 0:26–0:41 | `/scan` scanning panel | 40–50× speed-ramp |
| Result detail | 0:41–0:50 | `/scan` result | Normal speed |
| Issues and fixes | 0:50–1:14 | `/sample-report` | Slow scroll |
| Evidence methodology | 1:14–1:34 | `/methodology` | Slow scroll |
| Authenticated workspace | 1:34–1:58 | `app.lyrashieldai.com` | Clean stills + push cuts |
| Scan setup | 1:58–2:20 | `app.lyrashieldai.com` | Restrained slow push |
| Architecture / routing | 2:20–2:34 | Architecture card + `runner.ts` | Push + code zoom |
| Build Week proof | 2:34–2:48 | Verification card | Restrained slow push |
| Close | 2:48–2:55 | End card | Gentle fade |

## Voiceover generation with Deepgram

1. Ensure `.env` contains `DEEPGRAM_API_KEY` and optionally `DEEPGRAM_VOICE_ID` / `DEEPGRAM_MODEL`.
2. Run `node scripts/deepgram-narration.mjs` from the repo root.
3. Generated files appear in `artifacts/devpost-video/audio/`.
4. Review each file for correct pronunciation of LyraShield, GPT-5.6, Luna, Terra, HTTPS.
5. Re-render any section that sounds off by deleting its file and re-running the script.
6. Trim leading/trailing silence to 100–200 ms and normalize all clips to **-14 LUFS**.

## Pacing and sync tips

- Edit the **video first**, then lay the Deepgram audio under it.
- Use the storyboard timings as initial audio markers.
- If the generated narration is longer than the target segment, either re-render with a faster pace (Deepgram setting) or re-record via the script, not by speeding up the video.
- Keep cursor movement minimal and deliberate during product captures.
- Hold on each key UI element until the matching narration line finishes.

## Safety rules

- Do not show API keys, database URLs, email addresses, or unredacted target details.
- Do not present the authenticated workspace as a completed production scan.
- Do not start a paid full scan just for the video.
- Keep browser chrome, credentials, and customer data out of the export.
- Do not invent a progress percentage during the speed-ramp.
- The compression label must honestly reflect the actual wall-clock wait.

## Export and upload

- [ ] Assemble in your editor of choice and export H.264 at 1080p 30 fps.
- [ ] Burn captions into the picture.
- [ ] Export identical English SRT to `artifacts/devpost-video/captions-final.srt`.
- [ ] Verify audio is clear and captions remain readable.
- [ ] Watch the final export once before uploading.
- [ ] Verify the final export length is 2:55–2:59.
- [ ] Verify the public YouTube URL in a private/incognito browser.
- [ ] Paste the YouTube URL into the Devpost project only after the private-window check passes.
- [ ] Generate the submission Session ID by running `/feedback` in the primary Codex build thread.

## Files that should match the final video

- Narration source of truth: `docs/devpost/video/SCRIPT.md`
- Visual source of truth: `docs/devpost/video/STORYBOARD.md`
- Design source of truth: `docs/devpost/video/DESIGN.md`
- Caption sidecar (to retime from final narration): `artifacts/devpost-video/captions-final.srt`
- Deepgram input: `artifacts/devpost-video/narration.json`
- Deepgram script: `scripts/deepgram-narration.mjs`
