# Simplification remediation and final-pass evidence

Baseline: main `5fa62d5a6b377ca1491e2ef336a3391d8a760767`, including merged PRs #637, #638 and #640. Fix branch: `codex/simplification-review-fixes`. This receipt covers repository changes and isolated local acceptance. It does not establish deployment or exact-release coding-agent acceptance.

## Review resolution

| Finding                                                      | Resolution                                                                                                             | Regression                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1 / P1: failed scan operation executes again                | Only a newly claimed operation executes; ambiguous failures cannot be retried automatically                            | `scan-idempotency-route.test.ts`, `recorded-operation.test.ts` |
| R2 / P1: replay before authorization / wrong OAuth principal | Current resource and delegated scope checked before claim/replay; bind real OAuth connection and authorization version | `scan-idempotency-route.test.ts`, `agent-operation.test.ts`    |
| R3 / P1: old writers fail new principal requirement          | Additive database trigger supplies only the real connection principal and rejects contradictory identity               | `gate-service.runtime.test.ts` old-image raw INSERT            |
| R4 / P2: abandoned EXECUTING operation                       | Unsuccessful submission records a bounded failure; uncertain persistence remains non-retryable                         | scan route and recorded-operation regressions                  |
| R5 / P2: policy omitted from input identity                  | Canonical mode and effective policy ID are included in scan request identity                                           | scan policy conflict regression                                |
| R6 / P2: cross-principal operation lookup                    | Status lookup checks principal and current OAuth authorization version                                                 | `agent-operation.test.ts`                                      |
| R7 / P2: misleading connection usability                     | Expiry/status/scope-aware health, last success, owner recovery controls                                                | `connection-health.test.ts`, browser recovery test             |
| R8 / P2: concurrent snapshots                                | PostgreSQL transaction lock and recheck serialize scan/type snapshot creation                                          | four concurrent real-DB calls return one report ID             |

Snapshot serialization is database-coordinated through the shared service, not a unique index. Existing historical duplicates are preserved. Direct writers bypassing that service are outside this guarantee.

## Final pass across all 30 tasks

The following maps each task to the inspected implementation and regression group. The full test run covers the underlying authorization, evidence, queue, billing and compatibility suites. A passing model/contract test is not substituted for a human screen-reader session or a live provider/client receipt.

| Task  | Final-pass implementation / evidence                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| W1-01 | Shared terminology and compatibility URL tests                                                                                     |
| W1-02 | One home-next-action decision for header/panel, active-scan fixtures                                                               |
| W1-03 | Gate/applicability-first home decisions, insufficient and stale fixtures                                                           |
| W1-04 | Target-scoped gate presentation; score remains secondary context                                                                   |
| W1-05 | Simplified home metrics; mobile shell/browser regression suite                                                                     |
| W1-06 | Visible workspace persistence errors; shell regressions and tenant browser tests                                                   |
| W1-07 | Structured safe failure presentation, no automatic uncertain replay                                                                |
| W1-08 | Option 3 role projection tests, restricted administration and RLS tests                                                            |
| W1-09 | Activity navigation and historical approval URL compatibility                                                                      |
| W1-10 | Existing status/receipt components, OAuth and mobile browser journeys                                                              |
| W2-01 | Existing-workspace reuse and lazy default creation; stale workspace recovery now renders the updated state                         |
| W2-02 | Source-derived names, existing-target reuse and URL/API interaction regressions                                                    |
| W2-03 | Optional grouping remains outside the initial path; eligibility unchanged                                                          |
| W2-04 | Existing review presets and eligibility validation remain authoritative                                                            |
| W2-05 | Signed OAuth return survives GitHub install; completed onboarding returns to consent                                               |
| W2-06 | Optimistic state version rejects stale tabs; late repository responses discarded; revoked workspace reset; browser recovery matrix |
| W2-07 | Last completed per-target review read, manual selection version prevents stale override                                            |
| W2-08 | Connections destination with existing install catalogs and callbacks retained                                                      |
| W2-09 | Accurate capability/expiry state, last successful operation and owner recovery controls                                            |
| W2-10 | Direct Reports destination and compatibility navigation regression suite                                                           |
| W2-11 | Personal/workspace settings contract tests and unchanged administration gates                                                      |
| W2-12 | Finding filter/context restoration contract tests                                                                                  |
| W3-01 | Principal-bound scan/report/retest/fix REST keys, SDK/CLI/MCP propagation, failed/replay/concurrency tests                         |
| W3-02 | Canonical next-action helper wired into finding UI; risk decisions in secondary disclosure                                         |
| W3-03 | Receipt-derived remediation timeline tests; disposition separate from remediation                                                  |
| W3-04 | Existing trusted-merge retest webhook regressions; no additional queue producer                                                    |
| W3-05 | Serialized immutable private snapshot reuse and failed-assessment report regressions                                               |
| W3-06 | Existing notification grouping/dedupe tests; no acceptance emails sent                                                             |
| W3-07 | Native WebMCP registration/discovery/preparation and permission-loss rejection; optional callback options fixed                    |
| W3-08 | SDK status schema, CLI operation lookup, MCP operation lookup, server-owned recovery and principal checks                          |

## Local verification

- Core regression suite: 3,581 passed, 48 environment-dependent skips, zero failures (four workers). An earlier run alongside builds exceeded one existing test's five-second import timeout; no assertion was weakened.
- Marketing: 152 passed. Motion: 18 passed. Operational workflow scripts: 6 passed.
- Lint/typecheck: 65 Turbo tasks passed, including dependent package builds.
- Isolated PostgreSQL: 36 tests passed using a NOSUPERUSER/NOBYPASSRLS runtime role; includes old/new writer compatibility and concurrent report creation. CI now invokes both database runtime files, not only the original RLS file.
- Full nonvisual browser suite: 38 passed, five existing provider/affiliate placeholders skipped. Both targeted recovery/OAuth tests passed after the final onboarding changes, including the controlled GitHub recovery matrix and native Chrome 152.0.7977.76.
- Visual suite: mobile, tablet and desktop all passed (3/3), including keyboard access to the secondary risk decisions. Only the two finding-detail baselines changed for the inspected disclosure; all other baselines stayed unchanged.
- Production-mode Next build completed for the browser suite.
- Migration drift check: no difference against an isolated temporary shadow database.
- CI first-head browser run exposed a shared-IP fixture collision: the second tenant received rate limiting before authorization. The test now uses a separate simulated client IP and still requires 403. All three critical-flow tests pass locally; production rate limits are unchanged.
- Dependency audit: zero reported vulnerabilities.
- Connections inspected at 390px and 1440px, without horizontal overflow. Generated screenshots remain outside Git.

## Native WebMCP scope

The old blanket browser blocker is superseded. Local Chromium 151 and installed Chrome 152 expose native WebMCP with `--enable-experimental-web-platform-features --enable-blink-features=WebMCP`. Without flags, neither local build exposed `document.modelContext`. The regression logs the actual browser version and attaches its native tool results.

Registration, native discovery, preparation without persistence, callback invocation without execute options, and execution rejection after membership loss are tested. Durable paid execution, every cancellation timing, every browser release and all desktop coding agents are not claimed. The shared wrapper preserves an uncertain outcome if cancellation happens after a durable request may have reached the server.

Official reference: [Chrome imperative WebMCP API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

The GitHub recovery UI matrix uses controlled HTTP responses for slow/empty/revoked cases. Signed install return-state and ownership checks are covered separately. This is not a fresh hosted GitHub authorization receipt.

## Remaining release gates

PR-head CI, merge and deployment are separate states. Exact-release Codex, Claude Chat, Devin, Antigravity, OpenCode and Hermes lifecycle receipts remain pending. Claude Chat does not count as Claude Code. Production scan/payment/provider actions, marketplace publication, a human assistive-technology pass and native durable positive execution remain outside these isolated local receipts. No production configuration or billing admission changed.
