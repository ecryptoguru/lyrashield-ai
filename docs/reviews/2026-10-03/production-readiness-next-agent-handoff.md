# LyraShield next-agent handoff: production-readiness remediation

**Purpose:** continue the LyraShield production-readiness work from the current web candidate through exact-head review and release evidence. This document is self-contained for the next coding agent.

## Current state

- Web repository: ecryptoguru/lyrashield-ai.
- Branch: codex/production-readiness-20261002.
- Candidate base and fetched origin/main: 3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530.
- Candidate checkout: /private/tmp/lyrashield-ai-readiness-20261002.
- Engine main: a340d9d2fba716ff48e2996e950ba269783ce59a, merged as PR #198.
- Marketplace main: 8cb880dbaee73f2c6e71d096e4b75db87f29c32a.
- The primary engine checkout at /Users/defiankit/Desktop/lyrashield-engine has dirty user state. Preserve it; do not reset, stage or commit it.
- Candidate implements the W0–W8 work in the production-readiness plan. The completion ledger beside this file contains the current local test receipts and evidence boundary.
- Draft web PR URL: pending publication after the ledger and handoff commit. GitHub exact-head checks are not evidence until the PR exists.

## Source commit map

| Commit   | Scope                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| f971ec57 | W0–W1 payer-bound billing, rejection receipts, delegated target scope, sync permissions, webhook track recovery and additive schema migrations. |
| febbc216 | W2 scan recovery, dashboard and onboarding flows, polling behavior and browser coverage.                                                        |
| d50f5687 | W3 MCP operation-map contract, CLI behavior, detector and auth hardening.                                                                       |
| aae15b40 | W4 CI routing, credential separation, container checks, webhook cutover tooling and ratchets.                                                   |
| 3c786004 | W5 docs and marketplace source, client registry split, generated pricing and retention copy.                                                    |
| 1b171ed1 | W6 Desktop provider setup and failure states.                                                                                                   |
| 2d244a75 | W1 operations runbook and W7 retry, parser, settlement and permission test coverage.                                                            |
| 20f0d8a1 | W8 engine revision pin in release workflows and compatibility references.                                                                       |
| Pending  | Completion ledger and this handoff.                                                                                                             |

## Required execution

1. Verify branch base and PR identity before changing anything. Fetch origin and inspect status. Do not delete worktrees, switch the primary engine checkout or push to main.
2. Publish the single web remediation branch as a draft PR with the six required body parts: Result, Rulings honoured, Validation, Evidence boundary, Not touched and Report back. Include the W0–W8 commit map and exact local test receipts. The source diffs include protected billing, auth, migrations and deployment workflows.
3. Wait for all required GitHub checks on the exact PR head. Inspect every failed or skipped check. Fix failures in the same branch and rerun the affected local suites; push updates to the draft PR. Do not mark ready while any required check is red, skipped unexpectedly or tied to another SHA.
4. Keep the reviewer approval checkpoint on the final ENGINE_REVISION update. Keep the founder heads-up checkpoint before marking ready because this PR changes billing, auth and deploy behavior. Do not merge.
5. After a human merge, verify the Azure release, app/scanner images, worker image digest and both product/engine provenance. Public readiness checks alone do not prove worker provenance.
6. Only after the exact web merge SHA exists, regenerate the marketplace export and open the single marketplace PR. Validate all exported artifacts and run verifier fixtures in CI.
7. Record local, GitHub, deployed, provider and native-client evidence separately. Do not promote one evidence class into another in the final verdict.

## Candidate code groups

- W0: Razorpay payer-bound quote verification and signed rejection receipts; delegated scope checks and mutation-route inventory; sync write permission.
- W1: daily provider-only reconciliation; fenced recoverable webhook tracks; UTC scheduling migration; audited platform-admin recovery; rejection and retry tests.
- W2: scan refusal and terminal polling recovery; onboarding and checkout corrections; dashboard routing and accessible responsive UX.
- W3: MCP tool authorization contract, detector positives/negatives, CLI behavior, CSP ingest configuration, worker pool accounting and lock ordering.
- W4: credential-free image builds and dependency install; protected release routing, provenance, shell lint, pagination and blocking monotone ratchets.
- W5: generated documentation and pricing, client registry fixes and split, copy cleanup, privacy text and marketplace source updates.
- W6: Desktop provider wiring and failure-state UX. Unit/build checks do not count as clean-profile provider acceptance.
- W7: direct settlement/triage and permission coverage, parser adversarial inputs, defined debt cleanup and ratchet baselines. Do not invent closure IDs for the absent DA–DI register.
- W8: exact engine SHA in both release workflows and compatibility references. Keep the pin last among source changes; an additional docs-only ledger commit may follow to record the final commit map.

## Migration and protected-zone instructions

The new webhook scheduler fields are additive UTC TIMESTAMPTZ columns. Preserve legacy columns for compatibility. Production cutover is gated by the migration identity, current/compatible app and worker revisions, stopped admission, drained queues and active leases, signed receipt, accurate UTC backfill evidence and the rollback procedure in docs/reviews/2026-09-30/webhook-production-cutover.md. Tests and a clean shadow diff do not authorize a production migration.

Keep Razorpay signatures verified before parsing. Keep catalog rejection receipts payload-free and make duplicate delivery harmless. Keep all claim completion writes fenced by generation, token and lease. Replay automatically only for track handlers proven idempotent. The audited recovery operation stays behind platform-admin authorization and TOTP elevation.

Keep pricing numbers, the public score payload/allowlist, engine dependency caps, upstream strix source and engine worker pin unchanged. The known worker-consumer base 4822306e24f375800981bf282fd992a9c15dcde8 is an ancestor of web HEAD; the pin file itself is not present in this web checkout. Validate its canonical location in the engine repo without disturbing the dirty checkout. The web workflow ENGINE_REVISION is the engine release pin and must match in deploy-azure.yml and release-tauri.yml.

## Validation evidence already available

The completion ledger records the exact command outcomes. The most relevant candidate receipts are: two full pnpm test runs; pnpm typecheck; pnpm lint; pnpm build with disposable CI variables; browser harness 121/121; provider meter 14/14; webhook retry 13/13; queue producer 6/6; trial/workspace/Myra 16/16; route authorization 56/56; migration diff against an empty disposable shadow; all-source formatting; Markdown lint; ShellCheck; and workflow shell tests.

The webhook retry suite depends on disposable PostgreSQL and Redis plus a privileged system URL and a restricted runtime URL. Two lease-only fixtures now set their due timestamp to the past so those cases isolate claim expiry; the separate test still verifies database-clock defaults. Run the complete integration file after any related edits, not a narrow test-name filter alone.

Current public GET evidence on 2026-10-03 is health 200, scan readiness 200 with worker true, Myra status 200 with booking false and marketing homepage 200. These are for the deployed baseline. The candidate requires exact-head GitHub CI and a later production readback.

## Remaining operator/provider/client acceptance

- Search Razorpay and durable billing receipts for captured pack payments from 2026-09-11 onward; privately reconcile credit/refund decisions. Then make one authorized INR purchase and verify one credit under duplicate delivery.
- Apply the additive UTC scheduler migration only under the signed maintenance and drained-queue procedure. Verify UTC counts and operator alerts.
- After release, read back the active Azure worker and engine provenance; run a finding-bearing bounded scan, terminal findings retrieval, report generation and delegated cross-target denial.
- Use clean profiles to run ChatGPT and Azure Desktop scans on an owned fixture. Retain sanitized model/finding evidence and keep Local admission off until both pass.
- Regenerate marketplace only after the web merge and bind sourceCommit to that exact SHA.
- Resolve remaining founder rulings: billing rounding versus copy, connector context, pg_trgm, retention policy, clause-joining commas and unresolved labels. Recover the original DA–DI register before reporting any aggregate completion count.

## Token storage finding

Do not add the regenerated browser PAT to GitHub or Azure application settings. GitHub workflows use the automatically scoped GitHub token, Azure OIDC and the GitHub App credentials. The existing Azure Key Vault GHCR_TOKEN was checked without reading or printing its value; it is enabled, has no configured expiry and authenticated successfully to GHCR to read the current worker image manifest. Do not rotate or overwrite it without new evidence of authentication failure. Never put a personal token in a PR body, source file or chat log.
