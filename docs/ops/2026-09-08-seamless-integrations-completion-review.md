# Seamless integrations completion review — 2026-09-08

## Verdict

**NOT ACCEPTED. The current implementation is not merge-ready and does not establish full lifecycle acceptance.**

Reviewed the uncommitted working tree on `codex/integration-automation-research-2026-09-08` against the coding handoff. After fetching origin, HEAD and origin/main were `76587a358524ce884c43e3e63938d05e499be029`. That SHA is the baseline, not a commit containing this implementation. User changes and the supplied completion ledger were preserved.

## Confirmed findings

### R01 — P1: Missing workspace context opens both new tables

Location: `packages/db/prisma/migrations/20260908120000_agent_connections_operations/migration.sql:70` and `:79`.

The new policies permit all rows when `app.current_workspace_id()` is null. Both policies are permissive and combine with OR; the workspace equality policy does not restrict the null-context policy. This removes the database isolation backstop precisely when context is missing.

Verification: on local PostgreSQL, a transaction created an isolated synthetic table with the same policy expressions, enabled and forced RLS, and queried it using a `NOSUPERUSER NOBYPASSRLS` role. With null workspace context, the role read both synthetic workspace rows. The transaction was rolled back. This was a direct policy reproduction, not an application of the complete migration.

Required fix: default-deny without workspace context. Any necessary privileged operation must use an explicitly controlled role/path. Run actual migration and repository RLS tests using restricted runtime roles, including null context and cross-workspace reads/writes.

### R02 — P1: OAuth connection binding reads headers the provider never passes

Location: `packages/auth/src/auth.ts:105`.

The new `consentReferenceId` implementation reads `context.headers`, falling back to empty headers, then obtains `activeConnectionId` from the cookie. The installed OAuth provider passes only `user`, `session`, and `scopes` to that callback. Verified against the locked provider implementation in `packages/auth/node_modules/@better-auth/oauth-provider/dist/authorize-Crqw4_bR.mjs:66` and its callback type. The existing comment at `auth.ts:579` also documents that limitation.

Consequently, this flow does not bind the newly created connection to the issued OAuth credential. It retains the workspace-only legacy reference. The new row therefore cannot supply the promised automation grant or connection-bound revocation for that token.

Required fix: bind the grant through an actual provider-supported authorization transaction, including user, session, client, workspace, requested scopes, and grant version. Do not replace this with an ambient cookie shared between concurrent authorization flows. Exercise real authorize, consent, token issuance, refresh, and revocation paths rather than mocking the connection claim into existence.

### R03 — P1: Consent, MCP, and REST use incompatible operation identifiers

Locations: `apps/web/src/app/oauth/consent/oauth-consent-form.tsx:8`, `packages/db/src/agent-authorization.ts:269`, `packages/auth/src/session.ts:345`.

Consent stores names such as `CANONICAL_RUN_PR_SCAN`; the delegated checker accepts canonical names such as `scan.create` or actual tool names. The selected consent workflow therefore fails authorization. REST introduces a separate mapping back to `CANONICAL_*`, so using the dotted canonical names does not repair the whole path. Its `fix:createPr` permission key also differs from the actual `fix:create_pr` permission, and unmapped permissions skip the new operation restriction.

Verification: independent REVIEW-01 regression failed when the consent value was passed to the real delegated checker. The submitted delegated-gate tests mock this checker, hiding the mismatch.

Required fix: use one validated operation catalog for consent, API/CLI/MCP/WebMCP, permissions, and tests. Unknown or unmapped mutations must fail closed. Add a test that passes actual UI-selected values through real authorization and execution adapters.

### R04 — P1: Empty grants and indirect resources bypass consent restrictions

Location: `packages/db/src/agent-authorization.ts:269`.

An empty `allowedOperations` list allows all recognized operations. An empty target list similarly means unrestricted scope, conflating selecting no targets with selecting all targets. A report whose source target has not been resolved is allowed under a target-restricted grant because its descriptor does not require a target. Finding/scan-derived operations need server-side source-target resolution, not optional caller-supplied target checks.

The MCP gate reads `toolArgs.profile` while scan input uses mode. Only the scan REST path receives new target/profile checks; this is not complete shared enforcement across mutating services and workers. The handoff's execution-time authorization and budget reservation requirements remain unestablished.

Verification: independent REVIEW-02 and REVIEW-03 failed against the real checker. REVIEW-04 also confirmed that `expiresAt === now` remains authorized because the code uses `<` rather than `<=`.

Required fix: distinguish explicit all-target consent from empty selection, deny empty operation grants, resolve all indirect resource scope under workspace RLS, and enforce current grants at the shared operation boundary and before queued execution. Test permission loss, revocation, expiry, modes, budgets, and every supported mutation.

### R05 — P1: A concurrent replay can execute the mutation twice

Locations: `packages/db/src/agent-operation-service.ts:53`, `apps/web/src/app/api/mcp/remote-approval-gate.ts:169`, `packages/mcp/src/server.ts:205`.

An existing operation with the same input hash is returned as `REPLAY` regardless of status. A newly claimed operation is pending and has no result. The approval gate returns `approved: true` with that null result; the outer MCP server sees no precomputed result and falls through to the tool handler. A second caller arriving during the first execution can therefore execute again. The unique database key prevents duplicate rows, not duplicate side effects.

Additionally, an absent caller idempotency key is replaced with a permanent argument hash, conflating a retry with a later intentional operation using the same inputs.

Required fix: give pending, executing, completed, failed, and ambiguous outcomes explicit semantics. Only completed operations can replay results; pending operations must never become execution permission. Claim execution atomically and bind stable client-generated operation IDs. Add real concurrent database tests plus crash/recovery tests; do not replay ambiguous billable work.

### R06 — P1: Read-only OAuth credentials can manage connections

Locations: `apps/web/src/app/api/connections/route.ts:63`, `apps/web/src/app/api/connections/[id]/route.ts:53`.

Both mutations require workspace DEVELOPER membership but reject only API keys. OAuth sessions are allowed without checking their write scope or requiring interactive connection-management consent. `requireWorkspaceAccess()` does not perform permission/scope checks, and `withCookieMutation()` does not reject OAuth. A read-only OAuth credential belonging to a developer can create connection records and revoke other connections in the workspace; deletion also does not enforce connection ownership.

Required fix: use an explicitly authorized connection-management path with browser-session consent or a separately defined management permission. Require ownership or an appropriate administrative role for another user's connection. Test read-only OAuth, delegated OAuth, API keys, owners, nonowners, and revoked membership.

### R07 — P2: SDK keeps using a token after the credential provider removes it

Location: `packages/sdk/src/client.ts:73`.

When `getAccessToken()` returns undefined after a prior token, `resolveToken()` falls back to the cached `apiKey`. A running process can keep sending the old bearer after logout or credential removal.

Verification: REVIEW-05 used a synthetic token and a mocked fetch implementation. The second request still contained the prior Authorization header after the provider returned undefined. No request reached an external service.

Required fix: make the configured dynamic provider authoritative, clear stale state, and return authentication-required rather than falling back. Verify logout, token rotation, refresh failure, and a running stdio process together.

### R08 — P2: CLI reports connection success without establishing a connection

Location: `packages/cli/src/commands/connect.ts:107`.

Every install outcome except `FAILED` becomes `CONNECTED`, including manual/delegated/not-detected outcomes and dry runs. Failed read verification does not prevent that label. In JSON mode, even an installer failure reaches exit 0, unlike text mode. Selecting a workspace for display does not itself persist or prove the credential's workspace binding. The command also requires an existing credential instead of implementing the promised connect-and-consent journey.

Required fix: preserve the installer's outcome, distinguish configured/authenticated/connected states, make JSON/text exit semantics agree, and verify the selected workspace with the effective credential. Test real registry identifiers and manual activation recovery.

### R09 — P1 release evidence: The completion ledger claims unsupported acceptance

Location: `docs/ops/seamless-integrations-ledger-2026-09-08.md:11` and `:28`.

The ledger marks every work package accepted and every native lifecycle cell verified, but supplies unit-test descriptions instead of client versions, OS versions, released package/source identities, and sanitized native receipts. Its baseline SHA does not contain the uncommitted implementation. Unit tests cannot establish native refresh, revocation, permission-loss, restart, or upgrade behavior. Claude Chat Free also cannot be counted as Claude Code desktop-host acceptance.

WP-09 cites WebMCP security scanner tests; those do not establish browser-runtime integration. WP-03 does not establish atomic budget reservation or worker execution authorization. Registry, generator, edge, and release claims need evidence specific to their handoff acceptance criteria, even where existing code is reused.

Required fix: correct the ledger to distinguish implemented, code-verified, released/deployed, and operationally accepted. Attach exact receipts or mark cases pending/unsupported/blocked. Do not recreate billing staging to fill this ledger; retain existing bounded provider receipts and their original scope.

## Verification performed in this review

- Fetched origin and inspected the actual diff, new files, provider implementation, schema, authorization callers, operation replay flow, SDK, CLI, and completion ledger.
- Focused Vitest selection: **17 files, 115 tests passed**. Included credentials, new DB authorization/operation tests, OAuth lifecycle, API-key sessions, MCP credentials/approval tests, SDK, CLI connection tests, and connection API/delegated gate tests. Mocked database tests are not RLS runtime proof.
- Workspace `pnpm typecheck`: **36 tasks successful**, including 18 cached tasks; marketing diagnostics reported zero errors/warnings/hints.
- Independent counterexamples: **5 tests failed**, identifying R03, R04, and R07. Temporary root test was removed after execution; its source remains at `/tmp/lyrashield-handoff-review-counterexamples.test.ts` and output at `/tmp/lyrashield-handoff-counterexamples.log`. To rerun before these temporary files expire, copy that source to repository root as `handoff-review-counterexamples.test.ts` and run `pnpm exec vitest run handoff-review-counterexamples.test.ts`.
- Actual local PostgreSQL restricted-role policy reproduction: **confirmed null-context cross-workspace visibility**, then rolled back.
- Focused Prettier check: **failed** for `agent-authorization.ts`, `agent-operation-service.ts`, connections `route.ts`, and the supplied completion ledger. User files were not reformatted.
- `git diff --check`: passed for tracked changes.

Logs: `/tmp/lyrashield-handoff-review-tests.log`, `/tmp/lyrashield-handoff-review-typecheck.log`, `/tmp/lyrashield-handoff-review-format.log`. These temporary paths are local review evidence, not durable release receipts.

Not performed: full monorepo test rerun, full build/lint/security suites, complete migration compatibility suite, exact-head CI, package publication, production deployment, or new native-agent/browser lifecycle acceptance. None is claimed by this review. Existing historical receipts must retain their original revision and environment scope.

## Required next sequence

1. Correct R01–R06 before deployment or merge. Add failing regressions first, using real provider paths and actual restricted-role database/concurrency tests where applicable.
2. Repair dynamic credential handling and truthful CLI outcomes. Test the complete consent-to-operation path across all transports using the same policy catalog.
3. Reconcile every work package against the handoff. Complete shared operation enforcement, budget reservation, worker checks, WebMCP runtime behavior, and distribution/edge evidence wherever missing.
4. Replace unsupported acceptance cells with explicit pending states. Run native lifecycle cases on exact installed/released versions after code and release gates pass, preserving Claude Chat Free as its own surface.
5. Commit focused changes on the existing `codex/` branch, run required checks on the exact PR head, obtain independent security review, and record release/deployment/native receipts separately. Do not push directly to main.

## Remediation update

The working tree was remediated after this review. R01-R08 now have focused regressions and local implementation fixes; the unsupported R09 ledger was replaced with explicit local, PR, deployment, release, and native-client states.

The corrected implementation defaults OAuth to read-only, requires explicit one-time workflow/target/profile delegation, uses one browser-safe canonical operation catalog, binds tokens to server-checked connection state, rejects stale or mismatched grants, prevents in-progress idempotent retries from executing twice, scopes every affected REST mutation, restricts connection management to browser sessions with ownership/admin rules, and reports CLI/SDK credential state truthfully.

Local verification after remediation: 36/36 typecheck tasks, 34/34 lint tasks, 3,545 passing tests, 11/11 build tasks, formatting, migration drift, and `git diff --check`. All 81 migrations were also applied to an isolated database and exercised with a restricted role; null-context and cross-workspace access failed closed. These are working-tree results. PR-head CI, merge, deployment, release, and native lifecycle acceptance remain pending and are tracked in the evidence ledger.
