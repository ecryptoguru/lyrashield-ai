# LyraShield AI — OpenAI Build Week demo recording checklist

**Format:** 1920×1080, 30 fps, 16:9, stereo audio.  
**Target length:** under 3 minutes (previous export: 2:19).  
**Audio:** clean spoken narration, no background music.  
**Capture rule:** every narration claim must be visible on screen when it is spoken.

## Pre-recording setup

- [ ] Close all non-essential browser tabs, bookmarks bar, extensions, and notifications.
- [ ] Set browser zoom to 100% and use a clean profile if possible.
- [ ] Record at 1080p or higher; downscale to 1080p in export if needed.
- [ ] Use a quiet room and a wired mic or headset; do a 10-second audio test.
- [ ] Open the narration script on a second device or print it so it does not appear in the recording.
- [ ] Optional: load `docs/devpost/video/captions-draft.srt` into your editor as a timing reference.

## Public pages to capture (no login required)

1. **Landing page** — `https://lyrashieldai.com`
   - Show the hero and tagline.
   - Avoid scrolling too far; keep the hook line legible.

2. **Lite Check form** — `https://lyrashieldai.com` (homepage form) or `https://lyrashieldai.com/scan`
   - Enter `lyrashieldai.com`.
   - Wait for the Turnstile challenge and submit.
   - Capture the four-second progress state once, then the result.

3. **Lite Check result** — authorized result for `lyrashieldai.com`
   - Confirm visible counts: `0` needs attention, `0` worth reviewing, `5` look OK.
   - Keep the limitation text on screen.

4. **Methodology page** — `https://lyrashieldai.com/methodology`
   - Scroll slowly through the evidence states.
   - End on the "What this methodology does not claim" section.

5. **Sample report** — `https://lyrashieldai.com/sample-report`
   - Show the "Sanitized mock" banner and the four sections.
   - Keep the retained uncertainty visible.

## Authenticated workspace to capture (login required)

Use `https://app.lyrashieldai.com`.

1. **Dashboard / Targets**
   - Configure `lyrashieldai.com` as a public URL target.
   - Show the `Needs evidence` verdict and blank score.

2. **Scan setup**
   - Open the scan setup for the configured target.
   - Show `Release Check`, `Code Review`, and `Deep Security Review` options.
   - Do **not** start the scan.

## Repository and Build Week evidence to capture (local or GitHub)

1. **Architecture card**
   - Capture the repository-backed architecture summary from `README.md`, `ARCHITECTURE.md`, or a prepared slide.
   - Highlight: deterministic public checks vs. controlled GPT-5.6 repository reviews.

2. **Worker routing source**
   - Open `apps/worker/src/engine/runner.ts` at lines 187–199.
   - Show the Luna/Terra routing and `reasoningEffort: "medium"`.

3. **Current-revision verification card**
   - Run the test suite or show CI green status for the current revision.
   - Capture the exact counts for the revision you are recording:
     - 881 core tests
     - 79 marketing tests
     - 16 motion tests
     - 2 Chromium end-to-end tests
   - If the current counts differ from the script, update `SCRIPT.md` and `captions-draft.srt` before recording.
   - Capture the Codex task ID from the current build thread.

## End card

- Create or use the existing LyraShield AI end card with:
  - Tagline: evidence-backed release decisions.
  - Canonical domain: `lyrashieldai.com`.
  - No third-party logos, no stock footage.

## Recording order (recommended)

Record each segment as a separate clip. This makes it easy to re-record a flubbed line without redoing everything.

| Segment                 | Duration | Source                          |
| ----------------------- | -------- | ------------------------------- |
| Hook                    | ~11s     | Landing page                    |
| Lite Check form         | ~19s     | Homepage or `/scan`             |
| Lite Check result       | ~14s     | Authorized result               |
| Evidence model          | ~14s     | Methodology page                |
| Sanitized report        | ~11s     | Sample report                   |
| Authenticated workspace | ~12s     | Dashboard                       |
| Scan setup              | ~13s     | Scan setup, no scan started     |
| Architecture            | ~8s      | Architecture card               |
| GPT-5.6 routing         | ~7s      | `runner.ts` source              |
| Build Week proof        | ~21s     | Verification card + test counts |
| Close                   | ~9s      | End card                        |

## Narration and pacing tips

- Speak slightly faster than you think; pauses feel longer in the final cut.
- Match the script line to the exact moment the corresponding UI element is visible.
- If a section runs long, trim silence rather than speeding up the footage.
- Keep cursor movement minimal and deliberate during product captures.

## Safety rules

- Do not show API keys, database URLs, email addresses, or unredacted target details.
- Do not present the local authenticated workspace as a completed production scan.
- Do not start a paid full scan just for the video.
- Keep browser chrome, credentials, and customer data out of the export.

## Export and upload

- [ ] Assemble in your editor of choice and export H.264 at 1080p 30 fps.
- [ ] Verify audio is clear and captions remain readable.
- [ ] Watch the final export once before uploading.
- [ ] Verify the public YouTube URL in a private/incognito browser.
- [ ] Paste the YouTube URL into the Devpost project only after the private-window check passes.
- [ ] Generate the submission Session ID by running `/feedback` in the primary Codex build thread.

## Files that should match the final video

- Narration source of truth: `docs/devpost/video/SCRIPT.md`
- Visual source of truth: `docs/devpost/video/STORYBOARD.md`
- Design source of truth: `docs/devpost/video/DESIGN.md`
- Caption sidecar (to retime from final narration): `artifacts/devpost-video/captions-final.srt`
