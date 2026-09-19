# Review remediation — 2026-09-19

Approved implementation handoff. Baseline: `bb93f1133c73a39c3df4edace100b786653b8a11`.

## Constraints

Preserve design, architecture, account billing/RLS, evidence semantics, authorization,
keychain secrets, and release controls. No new dependencies, public REST changes,
schema migrations, pricing/model/pin changes, real bookings/emails/payments, or paid
scans. Keep four independently reviewable fix groups. Production merge/deployment
requires separate founder authorization. Tests must exercise behavior.

## Task 1: Support inbox (F2, F3)

Fix current-case/filter re-selection leaving loading stuck, and old mutation
completion replacing the newly selected case or clearing its draft/elevation.
Guard reads and action completion by current case identity and current filter.
Disable consequential controls if displayed detail and selected identity disagree.
Keep all server-side elevation/nonce controls.

Acceptance: delayed reply/PATCH A followed by selection B cannot replace B, clear
B's draft, restore an old filter, or target a case different from displayed detail.
Repeated active filter/case selection is a no-op. Cover errors, retries, and unmount.

## Task 2: Desktop lifecycle and usability (F1, F5, F6, F7)

Cancellation currently waits on the child mutex held across engine wait.
Route cancellation through the existing owner-task signaling approach, register
control before execution can race cancellation, and give durable terminal
persistence one owner and a monotonic event sequence. Repeated cancel is idempotent;
terminal scans never acquire contradictory cancellation events. Show Cancelling
until durable terminal confirmation; surface persistence/termination errors.

Await live-listener registration before replay, clean up partial/late listeners,
surface errors with retry, reset state on scan identity change, and reconcile with
stored scan detail. Add typed wrapper for existing get_scan_detail command.
Remove never-populated lastFindings state. Use existing list_scans/detail APIs for
history, reopen active/completed scans, and explicit finding selection for sync
(none selected by default). Only selected findings may leave the machine.
Add keyboard-accessible Back controls to scan and both sync states. Navigation
must not cancel scans/disconnect sync; late work must not navigate unexpectedly.

Acceptance: harmless child stops within two seconds; cancel before spawn, while
waiting, repeated, after terminal, and with output failure. Terminal state agrees
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
