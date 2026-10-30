# v26 verified fixes implementation

The user-approved detailed plan is in the chat of 2026-10-30. The validated review is `LyraShield-Deep-Review-v26-v3.md`. This file and the progress ledger persist task boundaries; the chat's detailed acceptance criteria remain binding.

## Global constraints

Preserve architecture, dirty source checkout, account-owned money, RLS, immutable evidence and approval binding. One active scan total per initiating user across workspaces, including queued and unresolved finalization. Other users sharing an account reserve capacity atomically. No production merge/deployment, paid tests, financial changes, alert mutations or upstream engine adoption. Keep exact-base Fix PR check, disabled personal notifications and failed/pre-provider non-billing. New migrations additive/forward-only. Use shared logger/domain/queue/security services. User authorized all local implementation; do not request another generic go-ahead.

## Task 1: A1 scanner CPU safety

Replace Docker directive, Gradle assignment and OpenAPI placeholder parsing with bounded linear work. Preserve valid syntax (Docker escapes/heredocs included), existing file/token limits and checksums. Apply missing file byte bounds before untrusted parsing; no blanket 8 KiB line cap. Precompute PHP delimiters and avoid overlapping recursive rescans. Enforce 100,000 token visits/statement and 1,000,000/file, retaining explicit partial coverage and prior findings on exhaustion. Yield between bounded chunks; no unbounded sync work. Narrow unsafe-regex disables where possible. Regression tests: malicious whitespace/braces/nested calls, isolated hard timeout, worker liveness and semantic fixtures. Timing ratios supplementary only.

## Task 2: A2-A3 user admission and billing

Implement user-owned durable UserScanSlot atomically in shared creation, all producers. Trusted initiating creator; queued/running/cancelling/unresolved finalization count. Conflict SCAN_ALREADY_ACTIVE 409 with only authorized scan links; same idempotency repeats reuse. Lock order user, workspace, sponsor. Release only confirmed stopped plus durable accounting. Account-owned ScanCapacityReservation keyed scan with WAITING/RESERVED/RUNNING/SETTLED/RELEASED/REVIEW_REQUIRED, cycle/funding/multiplier/runtime breakdown. FIFO capacity waits across users, no reservation while waiting. Reserve pool/packs plus existing eligible overage OR grace; do not add grace to overage entitlement. Deep/Custom 3x integer rounding; narrow policy/profile/execution-plan limits; stop 5sec before funded ceiling; excess absorbed, never charged. Revalidate before provider. Controlled capacity stop with trusted receipts bills partial work; genuine failure/preprovider remain free. Atomic exact-cap settlement does not roll back covered usage. Version new accounting; no historical rewrite. PostgreSQL red-first proof, cross-workspace/user races, grace/spend/pack/cycle boundaries, cancellation, crash/finalization/uncertain commit/idempotent retry tests. Waiting status and clear billing UI additive. Preserve immutable scan plans and shared queue authority.

## Task 3: A4 OAuth scope

Shared resolver limits explicit/omitted target reads; findings/fix proposals/statistics/counts/cursors identical scope. Empty grants empty list. Target-scoped readiness missing target 403; v1 alias same. Preserve session/API-key semantics, live grant revalidation, cross-workspace RLS. Check adjacent target read routes. Tests for allowed/denied/missing/empty/all/revoked/expired/paginated scope.

## Task 4: B1 onboarding

Browser-only choose-or-create workspace action, action-permission eligibility not OWNER-only. User/onboarding idempotency across tabs; create workspace/policy/membership/trial/selection atomically. Preserve ordinary explicit workspace creation and optimistic concurrency. UI offers eligible existing workspaces/name/role and create new; no oldest membership auto-adoption; preserve valid explicit selection/input and recover changed access.

## Task 5: B2 Fix PR lifecycle

Validate reconstructed approval hash before approve, retain atomic claim. Durable execution identity proposal/repo/base/checksum unique across principals/approval IDs, deterministic branch. Intent before remote mutation, idempotent PR persistence. Unknown remote/DB failures reconcile deterministic GitHub identity before retry, never duplicate; closed PR not auto reopened. Safe 4xx storage/provenance errors versus infra errors; strict extra-fields tests. Credential actor metadata/readable states. Retain exact base guard. UI awaiting/opening/opened/expired/stale/inactive/recovery/failed with true success only.

## Task 6: B3-B4 checkout credentials and scheduled/retest admission

Repository-specific contents:read tokens with workspace/installation/repo validation, active-integration recheck including deterministic retest; no shared Redis read-token cache. Preserve authorized write tokens, encrypt remaining shared cache/scope cache identities. Revocation/wrong-install/repo tests. Share relay availability across interactive/retest/schedule. Defer transient/user contention before consuming occurrence, coalesce missed runs; durable atomic occurrence+scan creation. Permanent ineligible advances with bounded reason/notification. No replay ambiguous paid work.

## Task 7: C1 scanner accuracy

Installed-version/package/ecosystem-aware fixed ranges, no misleading upgrades. PHP attributes/comments close tags; dated EOL catalog; keep historical IDs and candidate qualification. Docker stage/final-user, Compose mapping/list/_FILE and Terraform ingress/egress contextual fixtures. Unsupported manifests incomplete in mixed repos. OSV <=100/batch, concurrency 2, shared deadline, <=2 transient retries bounded Retry-After, cache only validated complete package data. Benchmark sink/count/location/precision fixtures.

## Task 8: C2 ecosystems

Shared capability contract. Exact registry Cargo.lock/Gemfile.lock with platform/source identity, unknown git/path/private sources partial. Digest-pinned isolated Go module resolver, no repo code/toolchain downloads/direct VCS/credentials. Respect contained workspaces/replacements/exclusions. Scoped metadata broker fixed approved hosts + DNS/redirect budgets, no opaque CONNECT. 90sec, 500 modules, 50MiB, shared deadline. Input/checksum/toolchain/image receipt. Unsupported/private/mutable/unresolvable partial. Claims only after qualification; Maven/Gradle excluded. Never go.sum-only selected-version claims.

## Task 9: D1-D2 dashboard UX

Elapsed versus charged whole/3x minutes, capacity/stop/finalizing states and permission-appropriate recovery, shared prices. Single-flight checkout pending across redirect with retry on actual error. Consistent loading/error/empty retaining data. Human labels, active GitHub status. Opt-in page API 50/page, loaded-results search+Load more; existing shape compatibility. Reset/add another target. Password-reset success without token; honest disabled preferences. Meaningful approval links/missing-workspace recovery/activity pagination.

## Task 10: D3 marketing UX

Stable exact copy command+failure status tests. Desktop details escape/outside/focusout; safe-area/dynamic mobile menu height. Latest user instruction defers D5 and all landing motion/layout changes: restore the five changed landing motion/runtime/layout files and existing motion browser regressions byte-for-byte from main `284523ca381ee0d6ffa62ce22e855f7ecae9518f`. Remove unused new loading/network helpers and D5-specific tests; retain independent header/copy acceptance. No new film scheduling, decoder cleanup, chapter counters or layout policy is implemented or claimed. One static light-theme text-color accessibility fix in `EvidenceMap.astro` remains, changing no motion or geometry. Film/runtime mapping, media and generation remain unchanged. Browser matrix qualifies preserved motion separately from header/copy behavior.

## Task 11: E tooling/ops/claims

Scoped SQL aggregates/paginated lists preserve complete totals; parallel only independent reads; measure bundle before changes. Shared contextual error helpers preserving status/headers/protocol. Ownership-aware env docs/checks, Astro/MJS parser-aware size checks, runtime target admission CI, CSS contract and marketing smoke selection. Deployment jobs timeout 15 preflight/metadata/cleanup,60 builds,45 deploy/rehearsal. Separate cleanup/secret-removal policy IDs without cosmetic-triggered rollback. Restore loopback/ephemeral credentials/env-name secret forwarding/sanitized logs/private snapshot integrity. Preserve approved alert routing; only draft low-rate alert policy. Fix retest/rounding/plan/enterprise/history wording/dates. Keep withdrawn P2-10/13/30 unchanged. Disposable P3 expiry/binding tests, inspect CSP/cache, Turnstile expected hostname/action. Dependency current-diff review only, no automatic bump/close/merge. Ledger each original issue with evidence. Full relevant lint/typecheck/unit/integration/build/worker-image/deploy suites and git diff check. Release proof explicitly outstanding without authorized production operation.
