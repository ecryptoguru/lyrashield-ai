# Launch-review remediation verification — 11 September 2026

The remediation merged in PR #657 as `71aa4db3` and production release
`34552773295` deployed it to `lyrashield-app--0000343` at 100% traffic. See
[account ownership and cutover](2026-09-11-account-billing-ownership.md).

The source verification below records the pre-merge candidate evidence. The production
receipt and cutover results are recorded separately so local tests are not presented as
runtime proof. No purchase-admission change, payment, or billable scan was performed.

## Findings and corrections

- Account ownership: billing contracts, allowances, usage, packs, grace and entitlement
  follow account identity; workspace attribution does not share access. Added restrictive
  RLS policies and a real PostgreSQL test denying a coworker's reads/updates even with a
  matching workspace context. Account-only grants work without workspace membership.
- Legacy migration: removed the erroneous earliest-workspace-owner assignment. The
  dry-run-first backfill now accepts existing ownership or an explicitly reviewed mapping
  to verified accounts, leaving unknown records unresolved. Historical grants and debits
  stay together on the mapped pool owner; do not infer old payer from scan creator.
- Annual renewal: monthly anniversary cycles, idempotent replenishment and account-only
  grants. A real restricted-client test proves one second-month 6,000-minute pool under
  concurrent replay while preserving the first-month consumed ledger. Open-ended
  complimentary terms also advance monthly.
- Remaining account callers: trials and fix-PR patch scope use the initiating account;
  provider contract metadata cannot reassign an already owned subscription; refund and
  settlement receipt reads bind their stored sponsor under account RLS. New subscription
  rows avoid the legacy unique workspace-attribution slot.
- Complimentary access: dry-run-first account operation, explicit operator/audit context,
  intent/completion audit, no workspace plan mutation, no-workspace grants, and reversal
  scoped to the exact complimentary billing row's grant metadata. No provider payment is
  created. The operation was later applied to the two authorized administrator accounts;
  each has a 6,000-minute Launch Assurance allowance.
- F2/F3/F4: constrained docs/blog/admin content and local table scrolling; added wrapping
  for inline paths and literal long list text found during Brave follow-up.
- F5: async-context log correlation with a runtime-compatible logger resolver and tests.
- F6: bounded API reference instead of the entire ~325k-pixel inline JSON view.
- Desktop: inclusive range lint correction retains the finite-value guard.
- OAuth: existing implementation also extracts consent-reference resolution with a
  fail-closed pre-consent sentinel and focused regression tests.
- Visual fixtures: retained the reviewed candidate snapshots and reran all three viewport
  sequences without further snapshot regeneration. Functional billing/affiliate E2E cases
  now execute rather than remaining placeholder skips.
- Removed a dangling `test:changed` package script pointing to a nonexistent file.

## Verification

Raw outputs are outside the repository in
`~/Documents/lyrashield-launch-review-2026-09-11/final-verification/`.
The manifest there binds final source commits and check results; these historical counts
must not be presented as CI or production results.

- Core: 3,768 passing tests, 12 explicit skips (including separately executed opt-in cases).
- Restricted PostgreSQL trial suite: 5 passing tests, run separately with its opt-in flag.
- Restricted PostgreSQL allowance replay: 1 passing test; account billing isolation: 2 passing.
  These are also included in core where their environment flags enable them; do not add
  those duplicate executions to a claimed unique-test total.
- Marketing/motion/ops suites: 152 / 18 / 6 passing tests.
- Functional Playwright: 43 passing; no placeholder billing/affiliate skips.
- Marketing browser suite: 27 passing, including six new overflow regressions.
- Visual Playwright: 3 passing viewport sequences. Prior expected/actual changes are in
  the candidate diff; snapshots were not updated during this final verification run.
- Desktop fmt, 70 Rust tests and Clippy: pass.
- Lint, types, production build, formatting, Prisma schema drift and dependency audit:
  final outputs retained. Check the raw result manifest for their final exit statuses.
- Brave: docs, blog table and bounded API reference inspected in the isolated preview;
  mobile overflow sweep repeated for all 53 previously flagged public URLs. Final raw
  measurements and screenshots are retained outside Git. Brave blocked navigation
  after the final preview restart (`ERR_BLOCKED_BY_CLIENT`), so the final Cline
  wrapping was verified by the new passing Playwright regressions, not a claimed
  fresh Brave sweep. This is changed-surface
  verification, not a fresh claim of all 359 URLs and every state being re-reviewed.

Database verification used task-created PostgreSQL at 127.0.0.1:55432 and Redis at
127.0.0.1:56379, with an explicit restricted role for RLS tests. The initial migration
command inherited a local DATABASE_DIRECT_URL pointing to 5432 and returned "No pending
migrations"; no migration was applied there. Subsequent commands explicitly override
both direct and runtime destinations. No production connection was used.

## Production completion and remaining evidence boundaries

1. The coordinated production cutover completed with zero unmapped billing, usage, or
   pack rows. The 12 non-admin test accounts were deleted through the normal deletion
   lifecycle; exactly the two authorized administrators remain. Historical ledger amounts
   were preserved, and the founder's 100-minute entry was neither guessed nor duplicated.
2. Account ownership is now the production contract. Rollback must use an account-aware
   image or a forward fix; an old workspace-only image cannot safely read or write the
   mapped rows.
3. The three Azure deployment identity secrets and federated credential are operational:
   release `34552773295` recorded successful Azure CLI OIDC login. The former v16 founder
   provisioning action is closed.
4. Live settlement, payout, tax, payment-method and capacity evidence remains external.
   Green checks do not prove those gates.
5. Engine source was unchanged. Marketplace provenance/copy is handled in its own PR;
   generated artifact validation is not an all-client installation/lifecycle acceptance.
6. No claims are made that inaccessible live shared-report, approved-affiliate, or full
   permission-state coverage gaps from the original review have disappeared.

The original review remains historical evidence. The account-billing remediation is merged,
deployed, and cut over. Full paid-launch signoff remains separate from these engineering
receipts and depends on the stated commercial evidence gates.
