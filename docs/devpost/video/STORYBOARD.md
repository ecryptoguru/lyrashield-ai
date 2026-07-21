# LyraShield AI — 3-minute OpenAI Build Week storyboard

**Format:** 1920×1080, 30 fps, 16:9; final export target 2:55–3:00.

**Audio:** AI-generated narration via Deepgram; no background music.
**Combined narration audio:** `artifacts/devpost-video/narration-full.mp3` (2:46.656).
**Captions:** `artifacts/devpost-video/captions-final.srt` retimed to the actual audio.

Edit the video to the combined narration track. The audio is shorter than the target length; fill the gap with the compressed scan visual and a brief end-card hold.

**Visual basis:** `DESIGN.md`.
**Recording checklist:** `RECORDING.md`.
**Narration source:** `SCRIPT.md`.

**Evidence rule:** every narration claim appears on screen at the moment it is spoken.

| Time        | Section | Source | Treatment | Required visible proof |
| --- | --- | --- | --- | --- |
| 00:00–00:12 | Hook | `https://lyrashieldai.com` hero | Clean capture, slow focus pull | Product tagline and the "what was tested" problem |
| 00:12–00:50 | Live Lite Check | Homepage form → `/scan?start=1` → scanning panel → result | Normal speed for setup and first rows; continuous speed-ramp through ~10 min wait; normal speed for result | Passive, read-only scope; pre-filled form; radar animation; `0/0/5` counts; limitation text; scorecard/waitlist CTA |
| 00:50–01:14 | Issues and fixes | `/sample-report` | Slow scroll + push cuts between four cards | "Sanitized mock" banner; detected candidate → independent verification → approval-bound fix proposal → retest + retained uncertainty |
| 01:14–01:34 | Evidence methodology | `/methodology` | Slow scroll | Five evidence states; explicit non-claims |
| 01:34–01:58 | Authenticated workspace | `app.lyrashieldai.com` dashboard + targets | Clean still sequence + push transitions | Configured `lyrashieldai.com` target; "Needs evidence" verdict; blank score |
| 01:58–02:20 | Scan setup | `app.lyrashieldai.com` scan setup | Restrained slow push | Release Check, Code Review, Deep Security Review; no scan initiated |
| 02:20–02:34 | Architecture and GPT-5.6 routing | Architecture card + `apps/worker/src/engine/runner.ts` | Restrained slow push + quick code zoom | Deterministic public checks vs. controlled repository review; Luna/Terra routing and `reasoningEffort: "medium"` |
| 02:34–02:48 | Build Week proof | Current-revision verification card | Restrained slow push | Codex task ID; 934 core, 80 marketing, 16 motion, 4 Chromium E2E tests |
| 02:48–02:55 | Close | LyraShield AI end card | Gentle fade | Evidence-led positioning and canonical domain |

## Fast-forward treatment — continuous speed-ramp

Because the live Lite Check for `lyrashieldai.com` takes approximately 10 minutes, the wait is compressed using a continuous speed-ramp:

1. Record one uninterrupted screen capture from form submission to result reveal.
2. In edit, keep the setup (00:12–00:26) at 100% speed.
3. Select the long wait segment (~10 minutes of wall-clock time) and apply a 40–50× speed increase.
4. Overlay a persistent lower-safe-area label: `Scanning · ~10 min compressed`.
5. Return the speed to 100% at the first frame where the `#results` panel becomes visible.
6. Do not invent a progress percentage; the UI already states the highlighted row shows activity, not completion.

## Capture gates

1. The recorded Lite Check result is the actual authorized result for `lyrashieldai.com`; revise the narration if a replacement capture differs.
2. The authenticated app footage proves workspace, target, and scan-setup UX only. It is not presented as a completed production scan.
3. Never initiate a paid or unproven full scan merely for the video.
4. Keep browser chrome, credentials, private account data, and customer data out of the export.
5. Record the full ~10-minute Lite Check in one continuous take so the speed-ramp is seamless.
6. Do not move the mouse or scroll during the wait; static framing makes the compression feel honest.

## Caption rules

- Use the final narration timestamps after Deepgram audio is generated.
- Keep each cue to a short conversational phrase and no more than two lines.
- Use one high-contrast caption group in the lower safe area.
- Correct product names manually: LyraShield AI, Lite Check, Codex, GPT-5.6, Luna, Terra.
- Burn captions into the picture and also include the identical English timed-text track and SRT sidecar.

## Acceptance checks

- [ ] Final export is between 2:55 and 2:59.
- [ ] The Lite Check form and exact result are legible at 1080p.
- [ ] "Five checks" appears only while the recorded count is visible.
- [ ] The compressed scan segment includes an honest compression label.
- [ ] Methodology and sample-report claims remain visibly scoped and sanitized.
- [ ] "Needs evidence" is spoken while the dashboard verdict is on screen.
- [ ] The scan-mode narration is paired with the real scan setup and no scan is started.
- [ ] GPT-5.6 routing is paired with the exact current source excerpt.
- [ ] The Build Week test counts match the current verified revision (934 / 80 / 16 / 4).
- [ ] Muted playback remains understandable; audio-only playback remains coherent.
- [ ] Public YouTube URL verified in a private/incognito window before pasting into Devpost.
