# WebMCP Demo Video Plan

## Scope and status

The [September 3 closeout plan](webmcp-closeout-plan.md) owns current release evidence, the founder-designated existing test account, entitlement checks, and the revised first-15-second timing. Follow it where this older recording plan differs; do not create a new judge identity.

This is a recording plan, not a published video. Keep the Devpost project as a draft until a real public YouTube URL exists and all required form fields are reviewed.

For the HyperFrames composition, tracks, visual identity, real-capture policy, and render gates, use [webmcp-hyperframes-production-plan.md](webmcp-hyperframes-production-plan.md).

The public Security Lab was rechecked in Brave on September 2. The unsafe sample produced 7 detected and 7 no-finding controls. Preparing the supported `WEBMCP-03` rewrite changes `exposedTo: ["*"]` to `exposedTo: []`; applying it in memory and rerunning produced 6 detected and 8 no-finding controls. No source-upload request or browser-console error was observed.

Native WebMCP proof is still required. The current Brave session does not expose `document.modelContext`; do not imply that it does. Before recording, obtain one headed supported-client capture showing a real native tool invocation. Use Chrome 149+ with the two official WebMCP flags enabled, or a supported ChatGPT desktop session. Do not claim dashboard-tool execution until an ordinary isolated judge account exists.

## Recording prerequisites

- Use only LyraShield-controlled pages, code, and screenshots. No customer source, credentials, private URLs, third-party trademarks, or background music.
- Open the public Lab at `https://lyrashieldai.com/tools/webmcp-security-checker` and confirm the visible 14-control copy.
- Capture one native public-Lab call within the first 15 seconds of the final cut. The tool must be visibly listed and invoked; a browser-local human click alone is not native-call proof.
- Keep the in-memory rewrite visible: selected `WEBMCP-03`, one-line diff, explicit Apply control, rerun result, and Undo.
- Capture the repository page showing public visibility and the MIT license. Use a CI page only when its run and revision are visible.
- Include dashboard footage only after ordinary-user, isolated-workspace, and cross-workspace-denial proof exists. Otherwise omit it rather than using privileged access.

## Script: target 2 minutes 45 seconds

| Time      | Screen                                                                                      | Narration and proof                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00–0:12 | Lab title and source-local notice                                                           | “WebMCP lets agents use page tools. LyraShield helps developers review that tool surface before it reaches production.”                                                                                            |
| 0:12–0:35 | Native inspector or supported-client tool list, then one `analyze_webmcp_source` invocation | Show the tool name, bounded result, and visible activity receipt. This is the required native WebMCP call.                                                                                                         |
| 0:35–1:00 | Unsafe sample and findings                                                                  | Load the public unsafe sample and run it. State that the browser-local check keeps pasted source on the device and returns deterministic evidence states, not a security guarantee.                                |
| 1:00–1:28 | Rewrite tab                                                                                 | Select `WEBMCP-03`, show the exact `exposedTo: ["*"]` to `exposedTo: []` diff, and say the user must review it before Apply.                                                                                       |
| 1:28–1:45 | Apply in memory, rerun, Undo                                                                | Show the control become `NO FINDING`, other findings stay visible, then Undo. Never imply a repository change was applied.                                                                                         |
| 1:45–2:05 | Public repository and CI/SARIF evidence                                                     | Show source, MIT license, and a green relevant CI run. Explain the same control model can gate pull requests and emit SARIF.                                                                                       |
| 2:05–2:28 | Dashboard only if judge proof exists                                                        | Show an agent preparing a scan form and the human Start control. Do not start a scan in the recording. If unavailable, replace with the public `/webmcp` control catalogue and the human-confirmation explanation. |
| 2:28–2:45 | Limitations slide or page                                                                   | “This is deterministic detection, not independent verification. Unsupported or dynamic source remains inconclusive. Runtime drift protection is future work.”                                                      |

## Editing and publication gate

1. Record one continuous clean take per segment at 16:9, 1080p, with system/audio narration and no external music.
2. Assemble only real captures; do not substitute mockups for native-tool or dashboard proof.
3. Verify locally: duration is under 180 seconds, audio stream exists, all URLs and revisions displayed are current, and no secret or privileged credential is visible.
4. Upload only after a fresh founder review. Set visibility to public and add the final YouTube URL to Devpost Project Details. This plan authorizes neither upload nor Devpost submission.
5. Reopen the public video logged out and confirm playback, audio, duration, and first-15-second native-call proof before any Devpost submission decision.

## Required evidence checklist

- [ ] Native public-Lab tool list and real invocation.
- [ ] Unsafe sample findings and source-local notice.
- [ ] `WEBMCP-03` bounded diff, Apply, rerun, and Undo.
- [ ] Public repository with MIT license and a relevant green CI run.
- [ ] Dashboard only with ordinary judge-account proof; otherwise public-pillar fallback.
- [ ] Final public YouTube URL, logged-out playback, audio, and duration proof.
