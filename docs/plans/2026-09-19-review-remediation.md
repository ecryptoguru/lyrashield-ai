# Review remediation — 2026-09-19

Approved implementation handoff. Baseline: `bb93f1133c73a39c3df4edace100b786653b8a11`.

## Constraints

Preserve design, architecture, account billing/RLS, evidence semantics, authorization,
keychain secrets and release controls. No new dependencies, public REST changes,
schema migrations, pricing/model/pin changes, real bookings/emails/payments or paid
scans. Keep four independently reviewable fix groups. Production merge/deployment
requires separate founder authorization. Tests must exercise behavior.

## Task 1: Support inbox (F2, F3)

Fix current-case/filter re-selection leaving loading stuck and old mutation
completion replacing the newly selected case or clearing its draft/elevation.
Guard reads and action completion by current case identity and current filter.
Disable consequential controls if displayed detail and selected identity disagree.
Keep all server-side elevation/nonce controls.

Acceptance: delayed reply/PATCH A followed by selection B cannot replace B, clear
B's draft, restore an old filter or target a case different from displayed detail.
Repeated active filter/case selection is a no-op. Cover errors, retries and unmount.

## Task 2: Desktop lifecycle and usability (F1, F5, F6, F7)

Cancellation currently waits on the child mutex held across engine wait.
Route cancellation through the existing owner-task signaling approach, register
control before execution can race cancellation and give durable terminal
persistence one owner and a monotonic event sequence. Repeated cancel is idempotent;
terminal scans never acquire contradictory cancellation events. Show Cancelling
until durable terminal confirmation; surface persistence/termination errors.

Await live-listener registration before replay, clean up partial/late listeners,
surface errors with retry, reset state on scan identity change and reconcile with
stored scan detail. Add typed wrapper for existing get_scan_detail command.
Remove never-populated lastFindings state. Use existing list_scans/detail APIs for
history, reopen active/completed scans and explicit finding selection for sync
(none selected by default). Only selected findings may leave the machine.
Add keyboard-accessible Back controls to scan and both sync states. Navigation
must not cancel scans/disconnect sync; late work must not navigate unexpectedly.

Acceptance: harmless child stops within two seconds; cancel before spawn, while
waiting, repeated, after terminal and with output failure. Terminal state agrees
with replay. Delayed/failed listener setup, replay failure, unmount, fast completion,
reopen, navigation, restart history, selected-only sync, zero-selection no-op,
entitlement errors and retry retain selection. Preserve native authorization.

## Task 3: Public Myra (F4, F9, F10)

Marketing public-token requests must omit cookies across bootstrap, messages,
identity, suggestions, confirmation, cases and booking management. Derive shared
client credentials from existing surface; dashboard keeps cookies. Keep CORS,
Turnstile, allowlist and CSRF enforcement unchanged.
Mobile marketing Myra below 640px needs modal semantics, inert background, scroll
locking, focus containment and focus return, while external Turnstile remains
visible/reachable. Resize restores desktop nonmodal behavior. Replace permanent
opens-soon demo paragraph with neutral capability-consistent copy.

Acceptance: public flows with app cookies work using public tokens; dashboard
cookies unchanged; cross-origin cookie mutation still denied; flag-off denied.
390px keyboard/challenge/Escape and 768/1440px resize behavior; demo open, closed,
timeout and management modes consistent. Mock external providers.

## Task 4: Polling and portable browser coverage (F8)

One in-flight scan poll and one scheduled timer per effect. Coalesce visibility
restoration with pending requests, schedule centrally only while visible/live.
Preserve ETags, backoff, bounded reconciliation, workspace/filter isolation; no
state updates after abort. Add portable desktop/tablet/mobile layout/interaction
assertions using existing Playwright infrastructure, not retired macOS snapshots.

Acceptance: repeated hide/show during slow fetch leaves <=1 request and timer;
hidden tabs stop, restoration resumes, stale responses cannot affect new scope.

## Verification and delivery

Each task: demonstrate regression RED/GREEN, focused suite, lint/typecheck.
Final: full tests, affected builds, lint/typecheck/e2e typing/format/diff checks;
dedicated test DB for E2E; desktop cargo fmt/clippy/test plus native lifecycle where
available. Browser viewport checks at 390/768/1440, keyboard, error/empty/loading,
overflow, console errors. Keep unsupported runtime claims explicit. Four focused
PRs; no merge or deployment. Record verification and remaining gaps here.

## Coding-agent handoff — implementation and review, 2026-09-19

All ten reviewed findings have implementation changes and regression coverage.
The branches are deliberately scoped for review. PRs #730, #731 and #732 were
merged by the founder; PR #733 remains open at this handoff. Do not apply the
cumulative `codex/deep-review-remediation` branch on top of those PRs: it
contains the same changes and exists only as the final integration test checkout.

| Group                 | Finding and trigger                                                                                                                                           | Change and primary code                                                                                                                                                                                                                                                                                                                                                        | Delivery                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Support F2/F3         | A delayed case read, reply or patch could replace a newer selection, clear its draft/elevation or leave a reselected case loading.                            | Bind reads and mutation completion to the current selected case/filter; keep the displayed detail and consequential controls aligned. `support-inbox-client.tsx`, `support-case-detail.tsx`; delayed-action browser tests and a detail regression.                                                                                                                             | [#730](https://github.com/ecryptoguru/lyrashield-ai/pull/730), merged `46e930de`                                |
| Desktop F1/F5/F6/F7   | Cancellation could wait behind the engine child mutex; live registration/replay, scan navigation, history and sync selection had lifecycle or usability gaps. | Owner-task cancellation with one durable terminal write and ordered events; await listeners before replay, recover stored detail, make Back controls keyboard accessible, reopen history and sync only explicitly selected findings. `scan/runner.rs`, `scan/store.rs`, frontend `App.tsx`, `ScanProgressScreen.tsx`, `ScanHistory.tsx`, `SyncScreen.tsx` and native wrappers. | [#731](https://github.com/ecryptoguru/lyrashield-ai/pull/731), merged `e74b2ee3`                                |
| Public Myra F4/F9/F10 | Public-token requests could carry browser cookies; narrow-screen Myra lost modal focus containment; demo fallback copy implied permanent unavailability.      | Derive credentials from the client surface, omit cookies on public calls, keep dashboard credentials; mobile modal focus/inert/scroll/resize behavior also contains cross-origin Turnstile iframe focus; use availability-neutral demo copy. `packages/myra/src/client.ts`, marketing Myra components, `demo.astro`.                                                           | [#732](https://github.com/ecryptoguru/lyrashield-ai/pull/732), merged `137c337b`                                |
| Polling F8 and DX     | Repeated visibility restore could overlap requests; manual Refresh could race an older detail poll and lose newer state/ETag.                                 | One scheduled timer and request per active effect, shared detail request owner, manual supersession with abort-safe commit and 304 ETag retention. Add portable browser harness/CI path gating and deterministic Desktop listener test. `use-active-scans-polling.ts`, `scan-detail-client.tsx`, `e2e/browser`, CI workflow/classifier.                                        | [#733](https://github.com/ecryptoguru/lyrashield-ai/pull/733), open; focused branch `codex/review-scan-polling` |

The follow-up commits on #733 are `1a852a1a` (manual/automatic request
coordination) and `2196cdbb` (deterministic late-listener test). An independent
reviewer found the manual Refresh race after the first polling commit, then
re-reviewed the correction with no remaining actionable finding. Myra's
mobile focus correction received the same independent re-review.

### Reproduce the verified local gates

Use an isolated checkout with the repository's pinned Node/pnpm versions and
generated Prisma client. The integration checkout was
`/Users/defiankit/.codex/worktrees/deep-review-remediation/lyrashield-ai` at
`2f5ef63d` before this handoff document; it includes the four groups. Run the
gates sequentially when possible: simultaneous full Vitest, browser, lint
and typecheck runs caused test timeouts on this host.

```sh
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser-harness
pnpm --filter @lyrashield/marketing exec playwright test -c playwright.config.ts
pnpm build
pnpm typecheck:e2e
pnpm lint:browser-harness
pnpm typecheck:browser-harness
pnpm format:check
pnpm prisma:migrate:check
(cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
git diff --check
```

The final integration run passed 34/34 lint tasks, 36/36 typechecks, 4,527
core tests (13 skipped), 269 marketing tests, 24 ops tests, 18 motion tests,
40 portable browser tests, 57 marketing browser tests, 11/11 package builds,
all formatting/typecheck gates and 84 Desktop Rust tests with fmt and clippy.
The first concurrent test run had timeouts; rerunning `pnpm test` sequentially
passed. A Desktop browser test occasionally raced its fixed 50 ms delay; the
final deterministic barrier passed five repeats and the 40-test suite. The
first migration-diff attempt found a stale function in this run's disposable
shadow database. Recreating only that dedicated shadow database made
`pnpm prisma:migrate:check` pass with no schema difference; no migration was
changed.

Authenticated `critical-flow` and `mobile-shell` Playwright checks passed
4/4 against a dedicated Docker PostgreSQL/Redis pair and restricted app role;
the test server performed a fresh production-mode web build. The browser
checks cover 390/768/1440 px where relevant, keyboard paths, stale response
ordering, listener cleanup and no horizontal overflow. The public Myra
browser checks mock Turnstile/calendar/email; they do not claim live provider
delivery. The authenticated run logged a Next.js `The destination stream
closed early` error on an aborted scan-detail RSC request while its browser
tests still passed; classify that log against a baseline before treating it
as a release regression. Generated plugin skill files can be touched by package build/tests;
restore only those generated deltas after verifying their origin.

### Next agent: release and runtime acceptance

1. Fetch current `origin/main` and the four PR states. PRs #730–#732 were
   founder-merged at the snapshot above. Verify #733's head includes both
   follow-up commits and this handoff, inspect its exact diff and CI result
   and avoid replaying commits already in main. Do not push directly to main.
2. After #733 merges through the protected workflow, compare its merge SHA
   with the built/deployed app, marketing and Desktop artifacts. Re-run the
   portable harness and targeted authenticated flows on the exact candidate.
   Production status and traffic must be read live, not inferred from green CI.
3. On an installed Desktop client, exercise licensed cancellation before
   spawn, during child execution and after terminal persistence; check event
   replay, history after restart, keyboard navigation and selected-only sync.
   The Rust unit/browser harness cannot prove macOS/Windows/Linux process-tree,
   real keychain, license, BYOK or Cloud entitlement behavior.
4. On the deployed marketing origin, check Myra with a browser carrying app
   cookies and confirm public requests omit them. Repeat mobile keyboard and
   Turnstile iframe focus, desktop resize, demo open/closed/timeout and public
   case management with real provider configuration. Mocked local tests do not
   prove provider email, calendar or challenge delivery.
5. Exercise scan list/detail polling in a real authenticated workspace with
   an active nonbillable fixture: hide/show during a held response, manual
   Refresh during a held poll, scope change, 304 ETag reuse, terminal finding
   fetch and error recovery. Keep paid scans and production mutations behind
   their existing approval and evidence gates.

No production deployment, real provider transaction, paid scan or installed
native-client acceptance was performed as part of this code review. Keep those
as separate evidence gates in the release record. The original product/engine
pins, billing/RLS boundaries and public claims policy were unchanged.
