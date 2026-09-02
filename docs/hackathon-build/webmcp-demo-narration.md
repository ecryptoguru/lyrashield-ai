# WebMCP Demo Narration and Caption Cue Sheet

## Recording contract

This is a factual narration script for the HyperFrames plan. It is not a subtitle file yet: final caption timings must be generated from the approved recorded narration, not copied from these provisional cues. Do not keep a line when its required real capture is absent.

Target length: 155–165 seconds at a measured, clear pace. Use no music. Spoken language must be confirmed before transcription; if English is recorded, use the English transcription model and replace the provisional cues with the resulting words and timestamps.

## Narration

| Time | Spoken copy | Required capture |
| --- | --- | --- |
| 0:00–0:12 | “Browser agents can act through WebMCP tools. LyraShield gives developers one reviewable way to inspect that tool surface before release.” | Lab title or `/webmcp` pillar. |
| 0:12–0:35 | “In a supported client, this public Lab exposes narrow tools to analyze local source or prepare one bounded rewrite. The visible result stays reviewable by the person using the page.” | Real native tool list, invocation, bounded result, and receipt. Omit this segment until captured. |
| 0:35–0:58 | “For a human, the same Lab works without a browser agent. Load the unsafe sample and run the deterministic local analysis. Pasted source stays in this browser; it is not uploaded.” | Privacy note, unsafe sample, and results. |
| 0:58–1:18 | “The result uses evidence states, not a security guarantee. Here, the Lab identifies seven controls needing review and keeps the rest distinct as no finding.” | Unsafe sample state summary. |
| 1:18–1:42 | “For the supported cross-origin exposure case, it prepares one small diff. The page changes wildcard exposure to an empty list. The person must review and explicitly apply it.” | `WEBMCP-03` selection, diff, and Apply control. |
| 1:42–1:57 | “After an in-memory rerun, that control becomes no finding. Other findings remain visible. Undo restores the original sample. No repository change happened here.” | Rerun result and Undo. |
| 1:57–2:18 | “The same control model can inspect repository source, emit SARIF, and fail a pull-request gate when assessment is unsafe or incomplete. The public repository includes its MIT license.” | Public repository, license, and relevant green CI. |
| 2:18–2:38 | “Inside LyraShield, an agent can prepare a scan form, while the existing human Start control remains the authority for durable work.” | Ordinary-account dashboard proof. Replace with public pillar limitation if absent. |
| 2:38–2:45 | “This is deterministic detection, not independent verification. Dynamic or unsupported source stays inconclusive.” | Limitations page or closing card. |

## Provisional caption groups

Use Bricolage Grotesque for statements, JetBrains Mono for control IDs and state counts, `#edf6fb` text, and semantic evidence colors from `apps/marketing-motion/DESIGN.md`. Place one group at a time in the lower 80–120px safe field. Captions must not cover browser controls or evidence values.

| Provisional time | Caption | Treatment |
| --- | --- | --- |
| 0:00–0:04 | Review WebMCP tools | Statement, cyan signal accent. |
| 0:04–0:08 | Before release | Statement, proof accent. |
| 0:08–0:12 | One reviewable record | Statement. |
| 0:12–0:17 | Narrow page tools | Mono label. |
| 0:17–0:23 | Local source. Bounded result. | Statement. |
| 0:23–0:35 | Human review stays visible | Statement, proof accent. |
| 0:35–0:42 | No agent required | Statement. |
| 0:42–0:49 | Load unsafe sample | Mono label. |
| 0:49–0:58 | Nothing uploaded | Proof accent. |
| 0:58–1:08 | Evidence states, not guarantees | Caution accent. |
| 1:08–1:18 | 7 DETECTED · 7 NO FINDING | Tabular mono; use only when matching live capture. |
| 1:18–1:28 | WEBMCP-03 | Mono control ID. |
| 1:28–1:36 | `[*]` becomes `[]` | Mono diff; use exact source syntax from capture. |
| 1:36–1:42 | Review before Apply | Caution accent. |
| 1:42–1:50 | 6 DETECTED · 8 NO FINDING | Tabular mono; use only when matching live capture. |
| 1:50–1:57 | Undo restores the sample | Statement. |
| 1:57–2:07 | Source scan · SARIF · CI gate | Mono label. |
| 2:07–2:18 | MIT licensed public source | Proof accent. |
| 2:18–2:30 | Agent prepares | Statement. |
| 2:30–2:38 | Human starts | Proof accent. |
| 2:38–2:45 | Detection is not verification | Caution accent. |

## HyperFrames caption implementation gate

- Generate final `captions.vtt` from approved narration, then replace every provisional start/end time.
- Group captions in measured 3–5-word phrases; one group visible at once.
- Fit all text to the 1600px landscape safe width before rendering.
- Give every caption an exit tween and hard hidden-state kill at its exact end time.
- Re-run lint, validation, visual inspection, and animation-map review after captions are added.
