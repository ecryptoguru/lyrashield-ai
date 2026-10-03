# LyraShield production-readiness remediation ledger

**Evidence date:** 2026-10-03, Asia/Kolkata.

**Verdict:** The deployed release is healthy. The web remediation is locally verified and published as draft PR [#897](https://github.com/ecryptoguru/lyrashield-ai/pull/897). It is not yet exact-head CI-verified, deployed or provider-accepted. Do not describe LyraShield as unqualified production-ready until the external gates below are evidenced.

This ledger updates the prior v23 review and its coding handoff. Historical findings remain useful context, but current source and the receipts recorded here take precedence. The original dirty engine checkout was preserved.

## Revisions and evidence boundaries

| Area                              | Revision or state                                                 | Evidence                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web main and candidate base       | 3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530                          | origin/main was fetched and still matches the candidate base. Candidate changes are in /private/tmp/lyrashield-ai-readiness-20261002 on codex/production-readiness-20261002.                                                                           |
| Web candidate                     | Draft PR #897; opened at a4e2fc4ef554a7967239399d23e76c2142a918dc | Eight ordered source commits plus the completion ledger and handoff are published. GitHub CI started on the opening SHA; this follow-up documentation commit advances the PR head, so use the linked PR for authoritative current SHA and check state. |
| Engine main                       | a340d9d2fba716ff48e2996e950ba269783ce59a                          | PR #198 is merged. Main CI run 36980692433 passed. The web candidate pins this SHA in both release workflows.                                                                                                                                          |
| Known engine worker-consumer base | 4822306e24f375800981bf282fd992a9c15dcde8                          | Direct commit ancestry to web HEAD passes. The pin file is not present in this web checkout. The original dirty engine checkout was not reset, staged or modified.                                                                                     |
| Marketplace main                  | 8cb880dbaee73f2c6e71d096e4b75db87f29c32a                          | Earlier local normal/release validation passed for 55 artifacts and verifier fixtures passed 46/46. Regenerate after the web PR merges so sourceCommit names the exact merge.                                                                          |
| Deployed web baseline             | 3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530                          | Earlier release and readiness workflows succeeded for this revision. Production still runs engine #195, not the candidate engine #198 pin.                                                                                                             |

Candidate parity checks confirm both release workflows point to engine main #198. The deployed worker reports engine #195. The candidate pin is required for the engine fixes to reach the worker after a reviewed merge and release.

## Commit map

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
| a4e2fc4e | Completion ledger and self-contained next-agent handoff.                                                                                        |

## Implemented candidate scope

| Group                            | Candidate status                               | Verified scope                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 billing and authorization     | Implemented                                    | Real Razorpay producer/consumer contract test, payload-free rejected-event receipts, delegated scope checks on report and gate mutations and relevant read routes, explicit mutation-route inventory, sync write permission and additional Myra route boundaries. No paid provider settlement is claimed. |
| W1 billing reliability           | Implemented                                    | Provider-scoped daily reconciliation, retryable renewal failures, fenced claims, reviewed replay policy, audited recovery disposition and additive UTC scheduling fields.                                                                                                                                 |
| W2 scan and customer flows       | Implemented                                    | Definitive refusal recovery, ETag handling, onboarding steps, plan selection, in-sheet errors, dashboard navigation, readable labels and responsive/accessibility fixes.                                                                                                                                  |
| W3 MCP and operational contracts | Implemented                                    | Tool catalog parity, input-hash denial, detector positives and negatives, CLI cancellation and mode behavior, CSP ingest configuration, pool accounting and lock-guard changes. Production error delivery is not proven by source tests.                                                                  |
| W4 CI and release                | Implemented                                    | Credential-free image builds, separated install/deploy jobs, routing and provenance guards, pagination, shell lint and monotone blocking ratchets. Exact-head GitHub CI is running on the current PR head; check the linked PR before changing its status.                                                |
| W5 docs and registry             | Implemented                                    | Registry split behind existing facade, client configuration fixes, generated pricing and integration references, copy ratchets, retention wording and marketplace source cleanup. Final export provenance waits on the web merge.                                                                         |
| W6 Desktop                       | Source and test work implemented               | ChatGPT and Azure wiring and UI states are covered by local tests. Clean-profile provider execution remains open; keep Local admission off.                                                                                                                                                               |
| W7 debt work                     | Implemented where defined in the supplied plan | Undici direct pins now agree with the patched lock resolution; smol-toml override is bounded. Defined decomposition, route tests, adversarial parser tests and ratchets are present. The complete historical DA–DI register was not found, so no full-register closure count is asserted.                 |
| W8 engine pin                    | Present in candidate                           | Release workflows point at engine main #198. Reviewer approval of this pin and successful exact-head CI remain required.                                                                                                                                                                                  |

The coding handoff contained stale statements: Desktop model wiring is in source for both providers and the CLI safe config writer is available. Those source facts do not substitute for a clean-profile Desktop scan or an end-to-end client configuration run.

## Local validation

The full prescribed runner completed twice on the candidate before the final webhook test-fixture timing isolation. That final change is limited to forcing due timestamps in two lease-specific integration fixtures; the separate database-clock scheduling assertion remains unchanged and the focused 13-test webhook suite passed after the adjustment.

- Frozen dependency installation passed with pnpm 12.2.0.
- pnpm typecheck passed: 36/36 workspace tasks.
- pnpm lint passed: 31/31 workspace tasks.
- pnpm test passed twice: core 666 test files passed and 8 were skipped; 6,669 tests passed and 85 were skipped. Marketing passed 319, motion passed 18 and operations passed 145. Named execution guards passed.
- Browser harness passed 121/121, including mobile-width scan and Desktop states.
- Focused Razorpay, top-up, scans, scan quality and report tests passed 56/56.
- Web test typecheck, E2E typecheck, browser-harness typecheck and browser-harness lint passed.
- Restricted local database and Redis checks passed: metering 14/14; webhook retry 13/13; queue producer 6/6; trial/workspace/Myra 16/16; team owner/runtime 4/4; growth metrics 1/1; dashboard overview and manifest checksum 2/2; account-preference RLS 2/2; agent-operation workspace FK 1/1. These used local disposable databases and the restricted runtime role where required.
- pnpm build passed 12/12 tasks with dummy CI-only values. The motion bundle-size notice is informational.
- pnpm test:browser-harness passed 121/121.
- Size ratchet passed with 189 existing warnings across 174 file/rule groups and no growth. Copy ratchet passed with 232 existing candidates across 76 files and no new candidate lines. Baseline monotonicity passed against 3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530.
- Formatting passed for all modified and untracked TypeScript, TSX, Markdown, JSON and YAML files. Markdown lint passed on 274 files. git diff --check passed.
- Prisma migration diff reported no schema drift against a newly created empty local shadow database. A first attempt used a missing database and a second used a nonempty stale shadow; neither is the successful receipt.
- ShellCheck and the workflow, release, billing-admission, secret-sync, provenance, egress, stop-provenance, Azure VM, alert and engine-check pagination shell tests passed. pnpm pin parity passed.
- Engine/worker contract, engine controlled-derivative gate and marketplace validation were verified earlier in this candidate run; see the source revision boundary above. Exact candidate GitHub CI has not run yet.

Initial unconfigured build and integration-test invocations lacked required disposable test settings. After configuring the documented CI-only environment, the required build and integration checks ran. During local webhook-suite stabilization, one invocation also exposed an exact-boundary scheduling sensitivity in lease-focused fixtures; those fixtures now set their due timestamp explicitly while the independent database-clock test still checks default scheduling.

## GitHub and live state

Draft PR [#897](https://github.com/ecryptoguru/lyrashield-ai/pull/897) is open from codex/production-readiness-20261002. It was created at a4e2fc4ef554a7967239399d23e76c2142a918dc with the required six-part review body and commit map. Initial GitHub CI began on that SHA. This follow-up ledger/handoff update will advance the branch head and start another run; the linked PR is authoritative for the current SHA and checks. Keep the PR draft until all required checks on the latest head are green and the reviewer/founder checkpoints are completed.

Fresh public reads on 2026-10-03 returned:

- app health: HTTP 200, status ok;
- scan readiness: HTTP 200, worker true;
- Myra status: HTTP 200, public true, booking false;
- marketing homepage: HTTP 200.

These are reads from the deployed baseline. They do not prove the candidate is live. Earlier Azure readback showed the healthy web/scanner revisions and worker image at web 3819345c… with engine 9d90be5a… (#195); refresh that readback after the candidate release.

The regenerated browser token does not need to be added to GitHub Actions or Azure. Workflows use the GitHub-provided token, Azure OIDC and the GitHub App integration. The Azure Key Vault GHCR_TOKEN metadata was checked without revealing its value; it was enabled with no expiry and successfully authenticated to GHCR and read the current worker image manifest. No token value was copied or changed. Keep personal access tokens out of application configuration.

## Remaining gates and operator work

1. Review exact-head CI on [PR #897](https://github.com/ecryptoguru/lyrashield-ai/pull/897) and resolve every failure or review finding. Do not merge the draft PR. The W8 engine pin still needs reviewer approval. Before marking ready, provide the billing/auth/deploy heads-up described in the handoff.
2. After merge and production release, read back active Azure app and worker images and verify product revision, engine revision and provenance. Repeat readiness and health checks, ten authenticated preference reads, scan completion with findings, terminal findings retrieval, report generation and delegated denial against another target.
3. Reconcile captured INR minute-pack payments since 2026-09-11 against durable credited receipts. Keep a private discrepancy list and correct only evidence-backed charges. Then perform an authorized INR pack purchase and duplicate-delivery check; source tests are not provider settlement proof.
4. Apply the additive UTC webhook scheduling migration only under the documented admission-stop and drained-queue procedure. Record pre/post row counts and signed cutover evidence. Verify recovery and rejected-event alerts reach their operator channel.
5. Run clean-profile Desktop scans for ChatGPT and Azure against an owned fixture, retain sanitized model identity, findings, terminal and report evidence, and keep Local admission off until both pass.
6. Regenerate the marketplace export from the exact web merge SHA and run both marketplace validators plus verifier fixtures in CI.
7. Recover the full historical DA–DI register before stating any total closure count. Resolve pending founder rulings for billing rounding, connector context, pg_trgm, retention policy, clause-joining commas and unresolved labels before changing their governed behavior.
