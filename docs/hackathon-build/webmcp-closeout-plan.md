# WebMCP hackathon closeout plan — refreshed September 3, 2026

## Purpose and authority

Complete the remaining judge-access, native-browser evidence, media, and Devpost draft work. This replaces the previous chat closeout plan where they differ. The founder selected an existing test account for judges; its login identifier and password belong only in the private handoff, not this public repository. Do not create the previously proposed judge alias or a replacement account.

This document began as planning and read-only verification. Its execution record below tracks only the safe, performed steps; it does not authorize account changes, scans, media generation, uploads, or Devpost saves. Final Devpost submission remains excluded. Retain the existing project title and founder answers: Individual, India, Existing application, Significant learning, and Yes for career value.

## 1. Refreshed evidence and material changes

- Fetched `origin` on September 3. Inspected `origin/main` at `cf2099321769f01256bb2ca96ad74816b363776e`; the original checkout remained at `74b270ccb94e2a2a410cc4ca596948720796831f`. Do not confuse the two. The planning branch starts at the fetched revision and leaves the original checkout untouched.
- Since the previous `31cd7fa0` baseline, 366 files changed. The shared WebMCP analyzer, public Lab adapter, and dashboard registration library have no source diff across these endpoints. Surrounding authorization, onboarding, scan eligibility, dashboard UI, and launch-readiness behavior did change.
- Exact-SHA [CI 33705800991](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/33705800991), [production release 33706133120](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/33706133120), and [scan-readiness workflow 33721890094](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/33721890094) completed successfully. The release readback includes successful image-build and Azure deployment jobs.
- Fresh unauthenticated HTTP reads returned 200 for the public Lab, control registry, `/api/ready`, and `/api/ready/scans`. The live registry contains 14 controls. These probes do not establish an authenticated journey, native-tool execution, or live image/digest identity.
- The September 2 Brave sample counts, no-upload observation, and Devpost draft status remain historical evidence, not a fresh September 3 browser result. Recheck before reuse. No completed video or current private judge-login receipt was established by this review.
- Deepgram variable names `DEEPGRAM_API_KEY` and `DEEPGRAM_TTS_MODEL` are present in the original checkout's ignored `.env`; values were not printed. No matching test-login credential was found in the checked environment or scoped local test artifacts. Resolve the existing credential through the founder's private credential channel before login; never guess or search unrelated personal stores.

### Execution record — September 3

- A fresh Brave run of the public Lab completed without source upload: the bundled synthetic sample reported **7 detected / 7 no finding** across the 14 controls. Preparing and applying the bounded `WEBMCP-03` rewrite changed only `exposedTo: ["*"]` to `exposedTo: []`; the rerun reported **6 detected / 8 no finding**, with `WEBMCP-03` at **NO FINDING**. This is a browser-local static demonstration, not native tool invocation or a security guarantee.
- The browser already held a session for a different privileged account and workspace, not the founder-designated judge identity. No sign-out, account change, membership change, scan, or data export was performed. A clean sign-in to the designated account remains required before its role and workspace isolation can be verified.

### Changes that affect this plan

- New workspace creation now calls `startTrial`. Trials are one-time per user, last 14 days, and cannot be reset by creating another workspace or removing membership. Reuse an appropriate existing workspace first.
- `FREE` is a plan, not a workspace mode. If a new workspace is ultimately necessary, use the existing valid `VIBE` mode and the normal server-assigned plan; account for trial side effects before creation.
- URL/API scan eligibility includes current entitlements and rate limits. Paid-plan remote reviews also require unexpired, workspace-bound domain proof. Non-billable deterministic execution does not mean unconditional admission.
- Browser-cookie mutations require same-origin validation. Use the real application UI and normal auth; do not add bearer headers or weaken origin checks to make tests pass.
- Team role changes and membership removal now exist with locking and last-owner protection. Accepting an old invitation deliberately does not change an active member's role; use normal team management for approved changes.
- The latest readiness change prevents an otherwise-clean partial assessment from showing unconditional `GO`: it becomes `GO_WITH_CONDITIONS` with no numeric score. No evaluated coverage remains `INCONCLUSIVE`; blocking findings remain blocking. Record the actual verdict and scope, not a staged all-clear.

## 2. Judge access: reuse the founder-designated test identity

### Pre-sharing gate

1. Resolve the existing test password privately and sign in at `https://app.lyrashieldai.com/sign-in` in a clean browser profile. Do not register the same email again, reset it automatically, request a new trial, or use a developer seed.
2. Verify the account is email-verified and has no platform-operator authority. Confirm password login works without sharing the email provider's password, OAuth provider account, recovery codes, or MFA secret. Do not disable MFA; if the current login requires founder intervention on every judge visit, report that as an access blocker.
3. Inventory **every** active workspace membership and associated access before releasing the password. Selecting one workspace or linking to one dashboard does not restrict the rest of the account. Inspect only the designated test account and its memberships; do not export customer data.
4. Reuse an existing synthetic-only workspace when it contains no customer data, production integrations, reusable credentials, payment authority, or unrelated sensitive records. Prefer the existing `DEVELOPER` role for the judge workspace. That role supports scan/finding/report and agent preparation workflows but not billing management, membership governance, fix approval, or agent approval.
5. If the account has an unsafe membership, privileged role, or sole-owner responsibility, stop credential sharing. Request a scoped owner-approved isolation/role change; do not silently demote the account, remove unrelated memberships, transfer ownership, delete data, or substitute another account.
6. Only if no suitable test workspace exists, have the founder's existing owner create an isolated workspace and invite the designated existing account as `DEVELOPER`. Check trial/entitlement consequences first. For an existing active membership, use the team role-change route after approval; an invitation cannot demote it.
7. Record the chosen workspace, role, email-verification result, expiry/entitlement summary, and positive/negative test outcomes in a private receipt. Keep login identifiers, passwords, tokens, workspace/customer identifiers, and session state out of the public plan and video.

### Content and availability

- Prefer an existing completed, authorized synthetic scan and its authentic report. Preserve its historical scan revision and coverage; do not relabel it as a fresh scan on the new deployment.
- If new evidence is needed, use one LyraShield-controlled URL target through the normal target workflow. Resolve its canonical mode and run the read-only eligibility preflight first. Check ownership attestation or domain proof as required by its plan. No arbitrary third-party target or fabricated scan/evidence row is allowed.
- Start a bounded deterministic scan only during the separately executed setup step, after admission succeeds. Do not start a scan merely to update this plan or during the scan-preparation recording. No engine/Deep acceptance or paid checkout is in scope.
- Determine whether entitlements and trial expiry cover the official judging period. Never promise continued scan admission based on a 14-day trial alone. Retained reports plus preparation-only access are the default fallback; verify they remain accessible with expired/no-minute entitlements. If they do not, flag the coverage gap for a founder decision without purchasing or granting credits.
- An empty findings result or scope-limited report is valid evidence when accurately labeled. Do not seed vulnerabilities or force a green verdict for presentation.

### Acceptance and private delivery

- Test fresh login, sign-out, workspace selection, dashboard, findings, retained report, and scan preparation. Repeat in Brave for the ordinary UI and in the actual supported native client.
- Verify unrelated synthetic workspace/target access, platform administration, billing management, member governance, and approval authority are denied at the API boundary, not merely hidden in navigation. Use controlled synthetic IDs rather than customer records.
- Confirm invalid/stale scan options remain blocked; preparing a form sends no scan-creation request. Verify denied writes do not leave durable effects. Exercise destructive or race cases in existing local tests, not against shared production data.
- Share credentials only through an explicitly organizer/judge-private Devpost field or a separately approved private organizer channel. Reopen public preview to confirm they are absent. If no verified private delivery route exists, withhold the credentials and retain the public Lab as the available path; authenticated judging remains incomplete.
- Because this is an existing test identity, coordinate any password rotation or session revocation with its other users and automation. Do not delete the account, disable its mailbox, or remove pre-existing memberships after judging. Plan post-judging password/session cleanup only after confirming the exact affected usage; remove only newly added judge-specific access when authorized.

## 3. Fresh browser evidence and release binding

1. At execution start, fetch again and bind the run to the then-current accepted SHA. Read CI/release once, then read actual app/worker revision and digest provenance using the existing deployment procedure. Record marketing and application provenance separately; an unchanged marketing deployment need not have the newest web-only SHA.
2. In Brave, repeat the full public Lab journey: unsafe sample, analysis, `WEBMCP-03` diff, explicit in-memory Apply, rerun, Undo, exports, keyboard navigation, and mobile/desktop layout. The old 7/7 and 6/8 counts are expected regression references only until observed again. Check console and network without including secrets or source in exported logs.
3. Confirm the public registry still has 14 controls and the Lab has two page tools. Do not call Brave native-capable unless the exact running build exposes `document.modelContext`.
4. Use a supported headed Chrome build for the native proof. Recheck the official setup at execution time, enable the documented testing/DevTools flags when required, and record version/configuration. Do not bypass browser-tool restrictions or present a shim as native support.
5. Invoke `analyze_webmcp_source` and `prepare_webmcp_rewrite` through the actual native client. Capture the real result and visible activity receipt, human review boundary, and unchanged source-upload boundary. On `/webmcp`, verify only `explain_webmcp_assurance` is exposed.
6. Using the approved test account, exercise page-specific `review_launch_readiness`, `review_findings`, and `prepare_security_scan`. Verify current role restrictions, navigation cleanup, cancellation behavior, bounded output, and no `POST /api/scans` from preparation.
7. Keep manual inspector execution and natural-language agent tool selection as separate receipts. Do not claim one proves the other. Run the existing evaluation prompts only in a client that genuinely supports that execution mode.
8. Capture current responsive navigation, findings, approvals, and WebMCP activity surfaces because these changed in v15. No new full-product feature tour is needed.

## 4. HyperFrames, Deepgram, and submission package

Keep the existing real-capture visual identity and 165-second target. Use the detailed video, HyperFrames, and narration documents for asset style, with the following corrections taking precedence:

- The listed sequence contains **eight** scenes, not seven. Use 0:00–0:05 for the hook and 0:05–0:35 for native proof; make the first real invocation visible before 0:15. Retain analysis 0:35–1:00, rewrite 1:00–1:28, rerun/Undo 1:28–1:45, repository gate 1:45–2:05, dashboard 2:05–2:28, and limits 2:28–2:45. Final captions follow measured audio, not these provisional cue boundaries.
- Use the configured Deepgram TTS model and earlier generator logic for English narration. Generate only from approved factual text; preview pronunciation before the full batch. Keep the API key process-private. Do not copy the full `.env` into an artifact project or client bundle.
- The old local recording script with embedded demo credentials is not the designated test account and must not be reused. Do not assume its hardcoded password belongs to the selected account. Remediation of that separate legacy identity requires establishing whether it exists and its scope first.
- Preserve the existing assurance-world composition. Use the dedicated ignored media workspace. Reuse the repository's pinned HyperFrames version unless a verified incompatibility requires a separately reviewed change.
- Replace the older proportional caption-timing helper with word timestamps derived from final audio. Verify the installed transcription capability before relying on it; if unavailable, prepare exact manually reviewed cues or report the tool gap rather than claiming automatic transcription occurred.
- Use real screen captures only. Keep all credentials, account identifiers, private URLs, user data, and internal costs out of audio, screenshots, overlays, captions, and video metadata. Missing dashboard or native proof remains a blocker or explicitly omitted claim, never simulated footage.
- Capture five final screenshots: public unsafe analysis, bounded rewrite, native invocation, repository/license/relevant CI, and the authorized dashboard preparation/receipt. A real scope-limited report may replace a redundant screenshot when it better explains the current evidence boundary.
- Run the pinned CLI's supported lint/check and inspect commands, plus full visual and timing review. Verify 1920×1080, 30 fps, H.264/AAC, audio present, readable captions, no clipping, and total duration strictly below 180 seconds. Do not pad to exactly three minutes.
- After founder review, publish the approved video publicly on YouTube and check logged-out playback. This remains an execution task, not something performed by this plan refresh.

### Devpost draft-only completion

1. Reopen the existing project and fetch current form requirements and draft status. The old September 2 2/5 status is not current proof. Verify live submission/judging dates; do not infer them from older notes.
2. Save Individual, India, Existing, Significant learning, and Yes for career value; leave organization blank where applicable. Preserve the project title.
3. Update the existing-project explanation from verified commit history. Distinguish WebMCP hackathon additions from pre-existing product and later general reliability fixes; do not claim all 366 changed files as hackathon-specific work.
4. Supply the live Lab, public repository/license, verified tested-client record, five screenshots, and final public video. Include Codex, HyperFrames, and Deepgram usage truthfully. Do not describe the backend MCP release as proof of native WebMCP execution.
5. Put the designated existing test login only in the verified private instructions. Public docs say that a private test account is available; they never reproduce the credentials.
6. Reopen every saved section and public preview. Record that all required values persisted and credentials are absent publicly. Stop before final Submit. No submission confirmation is expected or authorized.

## 5. Verification, handoff, and remaining inputs

No product API, schema, role, or auth changes are proposed. Account-access checks must succeed with the current implementation. If a confirmed defect blocks completion, prepare a minimal reviewed fix with regression tests and repeat exact-SHA CI, deployment, and live proof before captures.

During execution, use the existing tests for WebMCP discovery/evaluation/rewrite, dashboard registration, cookie-mutation origin checks, team role/removal/acceptance, last-owner protection, trial eligibility, domain-proof/preflight parity, and scope-limited launch readiness. Database-backed cases require the normal isolated test database, never production fixtures. Add no new framework or bypass.

Final receipts must separately identify source checks, CI, release, runtime provenance, public UI, native invocation, account isolation, media QA, YouTube playback, and Devpost save/readback. Green infrastructure checks cannot close authenticated or media gates.

Remaining private inputs/access are the existing test credential reference, an authenticated browser session for its audit, and any required founder MFA/Devpost/YouTube access. The account's live memberships, privileges, password-login behavior, and judging-period entitlement remain unverified. This is not a reason to recreate the identity or alter its access silently.

Excluded throughout: final Devpost submission, new judge alias/signup, automatic deletion/reset of the existing account, customer-data use, production billing changes, checkout, trial resets, direct database seeding, forced clean scores, and Deep/Terra acceptance.
