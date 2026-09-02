# Title

LyraShield AI — WebMCP Assurance

## One-line Summary

LyraShield AI helps developers build safer, more governable WebMCP tool surfaces—from a free browser-local checker to CI gates, evidence-bound scan reports, and human-confirmed in-product agent workflows.

## Problem

WebMCP gives browser agents useful ways to act on a web page, but a tool definition can quietly overstate its safety, expose it too broadly, accept unbounded input, skip cancellation, or mutate state without a human-visible confirmation step. Developers need a practical way to understand and govern that surface before it becomes a production incident.

## Solution

LyraShield is the launch gate for WebMCP tools your app exposes. It discovers imperative and declarative tool definitions, evaluates fourteen versioned controls, keeps incomplete analysis explicitly inconclusive, and supports only safe, deterministic rewrites. The same normalized model powers the free local Security Lab, repository scanning, CLI/SARIF, a fail-closed GitHub Action subset, and evidence-bound report receipts.

For agents inside LyraShield, the product adds narrow page-scoped tools rather than a broad new permission channel. Agents can review current launch readiness, filter/explain visible findings, or prepare a scan form. Existing server authorization and the human Start control still own every durable or resource-consuming action. A visible current-tab activity receipt explains what the agent did.

## Why This Matters

Humans and browser agents can now collaborate without making the agent opaque or overpowered: the human sees the source-derived result, the proposed rewrite, the exact page state that changed, and the confirmation boundary. Developers get one policy model across local experimentation, pull requests, repository scans, and reports instead of a one-off demo checker.

## How We Used AI

WebMCP is the browser-native agent interface. The product uses deterministic analysis rather than an LLM to decide the fourteen controls and safe rewrite eligibility, keeping results reproducible. Browser agents can invoke narrowly scoped, feature-detected WebMCP tools to analyze local source, prepare a review-required rewrite, explain public controls, and operate limited dashboard workflows within the signed-in user's existing authority.

## How We Used Codex

Codex was used as the engineering collaborator for design review, implementation, tests, adversarial security review, CI diagnosis, and release evidence preparation. The build used bounded parallel work across the analyzer, public tool, worker/report pipeline, CLI/Action gate, and dashboard tools. PRs [#497](https://github.com/ecryptoguru/lyrashield-ai/pull/497), [#498](https://github.com/ecryptoguru/lyrashield-ai/pull/498), and [#499](https://github.com/ecryptoguru/lyrashield-ai/pull/499) received focused review, post-fix security checks, and hosted CI. The published revision is `60eceeb249a16439951605ad6c10ae2f8d6e695d`; it has separate successful production-release evidence.

## Key Features

- A free, no-login WebMCP Security Lab that keeps pasted or selected source in the browser.
- Deterministic inventory and fourteen controls for behavior/annotation mismatches, external-content hints, exposure, origin isolation, confirmation, input/output bounds, cancellation, lifecycle cleanup, runtime validation, ambiguous contracts, embedded secrets, prompt injection, spec drift, and contract budgets.
- A fail-closed rewrite preview that replaces only statically provable wildcard exposure with an empty exposure list; all other cases stay review-required.
- Repository scanner and immutable report receipt with bounded coverage metadata and inventory checksum.
- `lyrashield check-diff`, SARIF, and a fast GitHub Action subset that fails closed when changed WebMCP source cannot be structurally assessed.
- Page-scoped dashboard tools for launch readiness, finding review, and scan preparation, backed by visible receipts and existing human confirmation.

## Architecture

`source or page state → normalized WebMCP tool surface → deterministic controls → bounded result or rewrite proposal → existing LyraShield evidence/report/CI path`

The heavy TypeScript and HTML parsers run only in the shared security package and in a dedicated lazy public-lab Worker. They are excluded from normal marketing and dashboard bundles. The runtime adapter feature-detects `document.modelContext`; browsers without WebMCP retain the full human UI.

## Testing Instructions

Public path:

1. Open the WebMCP Security Lab at the live URL below.
2. Load the unsafe sample and run analysis. It should show deterministic findings and a bounded inventory.
3. Select `WEBMCP-03`, prepare the rewrite, review it in the visible UI, apply it in memory, rerun analysis, and use Undo to restore the original sample.
4. Confirm that the page makes no source upload request; local source remains in the browser.

Native WebMCP path (headed Chrome 149+ or ChatGPT in-app browser):

1. In Chrome, enable `#enable-webmcp-testing` and `#devtools-webmcp-support`, then relaunch.
2. Open DevTools → Application → WebMCP on the Security Lab. Confirm exactly `analyze_webmcp_source` and `prepare_webmcp_rewrite`.
3. Run `analyze_webmcp_source` with `JSON.stringify({ "source": "unsafe_sample" })` if Chrome rejects an object argument. Expect a bounded result and a completed visible activity receipt.
4. Run `prepare_webmcp_rewrite` with `JSON.stringify({ "controlId": "WEBMCP-03" })` if needed. Expect `applyRequiredHumanReview: true` and no raw source or diff in the agent output.
5. On the `/webmcp` page, confirm only the read-only `explain_webmcp_assurance` tool.

ChatGPT Site tools discovers only top-level imperative tools; declarative forms and iframe tools remain Chrome-only test cases.

Authenticated dashboard path is pending an ordinary isolated judge account. Credentials, if needed, will be placed only in Devpost private testing instructions after normal registration and email verification—not in this repository, screenshots, or video.

## Public Demo Link

- WebMCP pillar: `https://lyrashieldai.com/webmcp`
- Free Security Lab: `https://lyrashieldai.com/tools/webmcp-security-checker`
- Published revision: `60eceeb249a16439951605ad6c10ae2f8d6e695d`. The live marketing response carries this exact revision marker; `https://app.lyrashieldai.com/api/ready` and `https://app.lyrashieldai.com/api/ready/scans` were healthy after release.

## Public Repository Link

`https://github.com/ecryptoguru/lyrashield-ai`

The repository contains a visible open-source `LICENSE`. Add the exact merged revision and final run instructions before submission.

## Demo Video

Record a public YouTube video under three minutes with audio: 0:00–0:15 problem; 0:15–1:05 Security Lab in Chrome and DevTools WebMCP pane; 1:05–1:35 review-required rewrite, Apply, and Undo; 1:35–2:10 CLI/SARIF, Action, and receipt; 2:10–2:45 dashboard preparation plus human Start control; 2:45–3:00 limitations. State that deterministic detection is not verification and that runtime drift protection is roadmap work.

## Screenshot Shot List

1. Free Security Lab with the source-local privacy note and unsafe-sample findings.
2. Native WebMCP DevTools Available Tools pane on the public lab.
3. `WEBMCP-03` review-required rewrite and visible Apply/Undo controls.
4. CLI/SARIF or green GitHub Action evidence for a safe diff.
5. Dashboard agent activity drawer showing a completed, non-mutating receipt.
6. Immutable report's bounded WebMCP coverage receipt.
7. Home-page WebMCP Security Checker link and dashboard DevTools WebMCP pane.

## Existing Project Extension Evidence

| Period        | Work                                                                                                                     | Evidence                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before Aug 25 | LyraShield AI platform, billing, scanner, and dashboard                                                                  | Not claimed as hackathon work.                                                                                                                                           |
| Aug 29        | Assurance engine, public Security Lab, dashboard tools, and Chrome callback compatibility                                | `dff57663`, `dfe3df0e` / PR [#498](https://github.com/ecryptoguru/lyrashield-ai/pull/498), `60eceeb2` / PR [#499](https://github.com/ecryptoguru/lyrashield-ai/pull/499) |
| Sep 2         | Embedded-secret and prompt-injection controls; Action and documentation hardening                                        | `f6a86d5c`, `fcdd60c2`, `825cbaa0`                                                                                                                                       |
| Sep 2–3       | Correct wildcard rewrite, current control count, spec-drift and contract-budget controls, and final submission materials | This pull request; add merged SHA before publishing.                                                                                                                     |

Verify this history with `git log --since=2026-08-25 -- packages/security/src/webmcp apps/marketing/src/pages/webmcp.astro apps/marketing/src/lib/webmcp-security.ts` before form submission.

## Submission Readiness Notes

- The Devpost draft project is [LyraShield AI — WebMCP Assurance](https://devpost.com/software/lyrashield-ai-webmcp-assurance) (ID `1405030`). Its factual title, description, links, and technology list are populated; it is not published or submitted.
- Required submission form answers include submitter type, country, app status, live URL, public repo, supported agents/clients tested, AI tools used, learning level, and career-value confirmation.
- Live Devpost requirements also require a public video under three minutes and a public repository URL.
- The native public-lab inspector and deployed revision are complete. Do not mark judge account, authenticated-dashboard proof, video, or final Devpost form answers complete until their receipts exist.

## Known Limitations

- A clean deterministic result is not a security guarantee or independent verification.
- Dynamic or unsupported source remains `INCONCLUSIVE` or blocks CI coverage rather than being treated as clean.
- The public checker is local-only and does not scan a remote repository or apply a repository change.
- The dedicated parser Worker is approximately 1.03 MiB compressed, above the original aspirational 250 KiB target, but is lazy-loaded only when analysis begins.
- Native WebMCP inspection needs a supported headed client; headless browser automation cannot supply that evidence.
- WebMCP is not presented as proof of search ranking, indexing, citation, or AEO/GEO outcomes.

## TODO Official Form Fields

- Submitter type: confirm whether this entry is an Individual or Organization.
- Country of residence: confirm final required selection(s).
- App status: use `Existing` only if the form answer accurately describes pre-existing LyraShield work and the submission-period additions listed above.
- Existing-project explanation: finalize against the merged release and live evidence.
- Exact live URL, native-client test record, judge testing instructions, final video URL, and final Devpost answer text.
- Confirm whether the official form asks for a Codex session ID. Do not record one unless the user confirms the correct session.
