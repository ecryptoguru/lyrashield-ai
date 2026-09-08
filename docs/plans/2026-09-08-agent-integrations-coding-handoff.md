# Coding-agent handoff: complete the seamless integrations program

Prepared: 2026-09-08. Repository: `/Users/defiankit/Desktop/lyrashield-ai`.

Design reference: [Seamless agent integrations: research and implementation design](./2026-09-08-seamless-agent-integrations.md).

**Status: implementation handoff. The new delegated-authorization system has not been implemented, deployed, or accepted.** This document specifies the work; its checklists are not evidence that the work is complete.

## 1. Assignment and intended result

Implement the full referenced design across CLI, SDK/API, MCP, OAuth, WebMCP, installers, generated plugins, and every supported coding-agent surface. Complete the applicable automated and native lifecycle tests, fix confirmed defects, and retain exact-version evidence.

The product outcome is:

> A user connects LyraShield once, explicitly authorizes selected workflows for selected targets, and those workflows subsequently execute without repeated LyraShield Review Queue visits or per-action consent. Refresh, restart, and compatible upgrades preserve the connection. Pause, revocation, permission loss, and policy changes take effect reliably.

This deliberately replaces the old rule that every OAuth write requires per-action approval **for newly consented delegated connections**. Preserve reviewed mode and historical approval records. Existing read-only credentials must never acquire write access silently. Existing write scope alone is not consent to new unattended behavior.

Coding-agent prompts, organizational policies, and browser permissions remain controlled by their owners. Configure documented LyraShield-specific trust during setup where supported. Do not disable unrelated host safety settings or advertise universally prompt-free operation.

Complete all work packages below. An external blocker on one client does not justify stopping independent engineering, tests, other clients, or documentation. Record unavailable entitlements, credentials, and vendor capabilities precisely; never turn a blocked requirement into a pass.

## 2. Scope and authorization boundaries

### Included

- All integration work in the research design, including the five current mutating MCP tools and nine current read tools.
- Common operation/target authorization across REST, `/api/v1` compatibility routes, CLI, SDK, both MCP transports, browser execution, and worker admission.
- Durable operation identity, replay protection, existing budget integration, and current evidence semantics.
- Consent, connection management, credential lifecycle, installation, diagnostics, recovery, upgrades, packaging, and provenance.
- Exact-release acceptance for every advertised supported path, prioritizing the six previously selected desktop surfaces.
- Cloudflare/ingress failure diagnosis and route-specific fixes when confirmed by current evidence.
- Updates to truth documents and support claims after implementation and release evidence exist.

### Preserved constraints

- No direct push to `main`, force-push, CI bypass, blanket upstream import, or overwriting user changes.
- Do not recreate retired billing staging or its Azure resources. Reuse retained provider receipts only for the behavior/environment/revision they actually prove.
- No real payment, production purchase-admission change, payout, unbounded model run, or billable acceptance scan is authorized by this handoff alone. Prepare those cases and use separately authorized bounded runs where needed.
- Do not send invitations, messages, or vendor bug reports without explicit user authorization. Prepare exact content and scope if sending is needed.
- Do not remove the sole workspace owner, revoke unrelated connections, clear all client credentials, or restart another active task indiscriminately.
- Preserve existing RLS, audit, queue, metering, evidence, policy, and licensing rules. An automation grant does not make a finding verified or a stale assessment applicable.
- Do not build new scanners, a new OAuth provider, a new gateway service, an arbitrary agent runtime, or native MCP for a client whose supported contract does not include it.

This handoff covers the integrations program. Keep earlier LS/LA/DX launch-remediation items in their existing ledgers; integration acceptance alone does not establish that every historical launch task is complete.

## 3. Starting state and first actions

At handoff preparation, `git fetch origin` completed and both local HEAD and `origin/main` resolved to `76587a358524ce884c43e3e63938d05e499be029`.

The active branch was `codex/integration-automation-research-2026-09-08`. The research document was a local untracked artifact. This handoff is also a local document until committed. **Preserve and include both documents in the appropriate reviewed change; do not assume either is already in remote Git.** Recheck status before editing.

Inspected source versions: CLI `0.2.4`, MCP `0.2.5`, Agent Plugin `0.1.24`, SDK `0.1.0`; Better Auth/OAuth provider lockfile version `1.7.1`. These are not proof of current deployment or every installed client.

First execution steps:

1. Read root `AGENTS.md`, `PRD.md`, `codebase.md`, the research document, and this handoff. Read any nested instructions for edited directories.
2. Fetch relevant remotes, inventory `git status`, worktrees, active branches/PRs, and generated/untracked files. Preserve existing worktrees and local client backups.
3. Resolve the current source baseline and any intervening changes. Use a focused `codex/` branch from current main or the appropriate dependency branch. Never discard the supplied documents to get a clean tree.
4. Inventory current runtime and client identities without printing credentials. Separate source versions, released packages, installed packages, deployed SHA/digest, and client versions.
5. Create an execution ledger from section 14. Fill every applicable client row before beginning acceptance. Keep a continuation note with last completed step, active work, next command, and blockers.
6. Reproduce the first credential defects with regressions. Begin implementation with WP-01; do not start by removing the approval gate.

Prior focused baseline: 229 tests passed across 14 files. This is historical evidence for the inspected source only. It is not a full build, PostgreSQL/RLS runtime run, or native-client acceptance.

## 4. Confirmed code map and ownership

Paths below are repository-relative. Confirm symbols and callers again before editing.

| Area                      | Existing files/packages to extend                                                                         | Responsibility                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Shared credentials        | `packages/credentials/src/index.ts`                                                                       | Credential schema, precedence, storage, refresh, revocation helpers                                        |
| CLI credentials and login | `packages/cli/src/credentials.ts`, `commands/login.ts`, `commands/doctor.ts`, `commands/install.ts`       | Interactive/headless UX and composing existing flows                                                       |
| SDK                       | `packages/sdk/src/client.ts`, existing resource modules                                                   | Request-time bearer provider, errors, operation identity, compatible public types                          |
| OAuth/auth                | `packages/auth/src/{auth,oauth,session,oauth-workspace,oauth-resource}.ts`                                | Issuer/resource validation, consent binding, membership, role and scope checks                             |
| OAuth UI                  | `apps/web/src/app/oauth/consent/oauth-consent-form.tsx`, workspace selection/query modules                | One-screen explicit consent and resumable redirect                                                         |
| Hosted MCP                | `apps/web/src/app/api/mcp/{route,remote-approval-gate}.ts`                                                | Authentication and transport adaptation; preserve reviewed mode                                            |
| MCP package               | `packages/mcp/src/{tools,tool-policy,server,create-server,http-transport,stdio-transport,credentials}.ts` | Canonical tool mappings, transport behavior, structured results                                            |
| Database                  | `packages/db/prisma/schema.prisma`, migrations, existing services, RLS helpers                            | Connection grants, execution identity, reservations, audit references                                      |
| Existing approvals        | `packages/db/src/agent-approval-service.ts`; `api/agent-approvals` routes                                 | Historical exact-input review/claim/replay; no fake approvals for delegated calls                          |
| Mutations                 | `api/scans/route.ts`, `api/reports/route.ts`, finding/fix-proposal/retest routes, `/api/v1` aliases       | Authoritative operation authorization and current resource lookup                                          |
| Fix PR creation           | `apps/web/src/app/api/fix-proposals/[id]/create-pr/route.ts`                                              | Preserve server-generated patch and source binding; adapt authorization only if this workflow is delegated |
| Queue/worker              | `packages/integrations/src/queue.ts`, existing worker admission/execution services                        | Recheck queued operations, stable job identity, recovery, actual usage settlement                          |
| Browser tools             | `apps/web/src/lib/webmcp`, `components/webmcp`, dashboard WebMCP hooks                                    | Feature detection, page lifecycle, narrow execution adapters and receipts                                  |
| Client registry           | `packages/agent-registry/src/{agents,types,schema,render,index}.ts`                                       | Client/surface/version contracts and evidence-backed renderer selection                                    |
| Installation/export       | `packages/cli/src/installers`, `packages/agent-plugin`, marketplace generator                             | Safe configuration merge, activation, generated exports/provenance                                         |
| Validation/release        | Root scripts, `.github/workflows/ci.yml`, release workflows, existing Playwright configuration            | Exact-head checks, restricted DB roles, deployment and native evidence                                     |

One implementation owns shared authorization; transports adapt it. One credential implementation owns refresh/storage; CLI and MCP consume it. One registry owns support and installation advice. Do not create parallel policy tables in UI, MCP, SDK, and worker code.

## 5. Work packages and dependencies

Every work package needs a focused regression or conformance check, an implementation diff, required verification, and a ledger entry. Shared-schema decisions must be settled before dependent consumers are edited.

### WP-01 — Repair credential refresh and persistence

**Dependencies:** none. **Primary ownership:** credentials, SDK, CLI/MCP credential consumers.

Tasks:

- Reproduce: CLI and MCP save only when the access-token string changes; a refreshed token set with a changed refresh token/expiry can be discarded.
- Reproduce: a long-lived stdio server keeps the startup token in its context after expiry.
- Extend the shared credential schema with versioned issuer/resource/client/connection identity and profile selection. Migrate the current single-profile file without losing existing credentials.
- Preserve explicit environment precedence. Reject accidental transmission of stored credentials to an unrelated origin selected by an override.
- Add a backward-compatible async bearer provider to SDK requests. Native HTTP hosts retain ownership of their own OAuth caches.
- Put read/refresh/write/logout behind one cross-process coordination mechanism; re-read after acquiring it. Preserve private atomic file replacement. Include bounded lock waits and safe stale-lock recovery.
- Save every changed token-set field. Missing expiry is unknown, not indefinite validity. Do not manually decode a JWT and treat that as signature validation.
- Distinguish transient network/provider errors from invalid or revoked grants. Keep usable credentials during transient failures; use bounded retries.
- Ensure logout/revoke generation wins over an in-flight refresh. Never resurrect a deleted profile from a late response.
- Resolve credentials for each request in long-lived stdio. Retry an invalid-token rejection at most once and only under the safe retry rules in WP-03.

Required cases: unchanged access/changed refresh; unchanged access/changed expiry; refresh-only response handling as supported by provider; parallel CLI+MCP refresh; process crash around save; logout race; corrupt file; immutable env token; origin mismatch; natural expiry; transient 429/503; permanent `invalid_grant`.

**Done:** one shared lifecycle implementation passes tests; existing static API-key SDK consumers remain compatible; a long-lived stdio session refreshes without restart. Native third-party refresh acceptance remains a separate receipt.

### WP-02 — Define operation authorization and additive storage

**Dependencies:** operation/identity design review; may begin after WP-01's interfaces are clear.

Tasks:

- Extend the existing tool catalog with canonical operation IDs, resource requirements, allowed input schema, mutation/usage classification, and reviewed/delegated behavior. Cover all fourteen tools.
- Add a versioned connection/grant record, conceptually `AgentConnection`, referencing current workspace, principal, OAuth client/session or API key, and consent record. Avoid duplicate credential storage.
- Bind allowed target IDs to their actual repository/domain/artifact identity. Define how target edits invalidate or require narrowing/reconsent.
- Store operation allowlists, allowed scan profiles, limits, consent actor/time, optional expiry, status, authorization version, and revocation time.
- Add operation records only where existing operation-specific idempotency is insufficient. Use unique constraints and RLS for durable request identity, input hash, execution state, result reference, and usage reservation references.
- Define narrow DTOs; return no raw secrets, evidence storage locations, or internal cost fields.
- Add forward-only migrations with old/new application compatibility. Update `WORKSPACE_SCOPED_MODELS` only for models with `workspaceId`; update soft-delete sets only when supported by schema.
- Audit through the existing extended client and its chain-locking rules. Do not nest `prisma.auditLog.create()` inside another transaction. If a transaction needs a durable audit handoff, inspect/reuse the established mechanism and prove eventual chain insertion before treating sensitive completion as accepted.

Required cases: cross-workspace reads/writes, role ceilings, malformed policy, unknown operation, negative limits, exact expiry, target identity edits, immutable consent history, migration compatibility, audit-chain integrity.

**Done:** schema and services are reviewed and tested under actual restricted roles. No production credential is yet granted new authority.

### WP-03 — Durable execution, replay, budgets, and worker admission

**Dependencies:** WP-02.

Tasks:

- Bind a logical action to connection, operation, caller idempotency key, canonical input hash, and authorization version. Alias tool names share the canonical operation.
- Same key/input returns the existing result or in-progress operation; changed input returns a conflict. A deliberate second action uses another key.
- Preserve operation IDs through CLI/SDK retries. MCP exposes compatible caller-supplied idempotency and returns an operation reference promptly.
- Do not claim exactly-once effects for a caller that loses the first response and retries without stable identity. Provide bounded lookup/reconciliation and clear ambiguous status.
- Inspect current transaction/queue recovery before adding an outbox. Ensure accepted actions survive the commit/enqueue gap and do not enqueue twice.
- Enforce reservations atomically across clients, key-rotation overlap, and simultaneous requests. Use existing Decimal amounts, entitlement rules, metering, settlement, and release of unused allowance.
- Recheck active connection, current target/policy, and eligibility when queued work is admitted to an external stage.
- Define the ordering boundary precisely: admission serialized after committed revocation must fail. Work already admitted may be in flight; document safe cancellation/drain behavior. Do not promise that revocation can undo a network request already sent.
- Recheck permission before replay/status/download; an operation ID is not a bearer capability.
- Preserve current retest lineage and evidence outcomes. Requesting a retest must not directly set `VALIDATED`, `VERIFIED`, or `FIXED`.

Required cases: duplicate concurrent requests; same key/different target; crash after claim/commit/enqueue; lost response; ambiguous external effect; 50 concurrent requests; shared allowance ceiling; revoke/admit race; unstarted queued work after revoke; revoked result access.

**Done:** a repeated automated request cannot silently duplicate a logical action or bypass budget/evidence policy; failures recover through existing queues without replaying ambiguous paid work.

### WP-04 — OAuth connection binding, consent, and immediate disconnect

**Dependencies:** WP-02; WP-01 for CLI-owned credentials.

Tasks:

- Confirm the locked provider's hooks can bind an immutable connection ID and authorization version into authorization-code and refresh issuance. Test this before choosing a fallback.
- Add explicit versioned automation consent, for example a separately advertised automation scope plus the server grant. Old read/write scopes do not acquire new meaning.
- Bind consent to a server-owned authorization transaction: user, requested client, workspace, capability set, resource, state, and expiry. Concurrent logins cannot race through a shared active-workspace setting.
- Preserve PKCE S256, state, issuer checks, exact redirects, public/native classification, audience validation, and existing metadata endpoints. Do not weaken `iss` validation for an affected client.
- Rate-limit and validate DCR. Pre-register legitimate hosted callbacks where appropriate. Client names and logos are untrusted display metadata, not vendor identity.
- Support metadata-document clients only if the provider contract and safe metadata fetching are established; otherwise retain supported preregistration/DCR. Do not advertise unsupported capabilities.
- Check a signed connection binding against current server state. Revoke/pause must work while an access token is still cryptographically valid.
- Persist LyraShield's revocation barrier before asynchronous provider cleanup. Expose cleanup failure without pretending that a self-contained JWT was revoked by the provider endpoint.
- Reconnect uses a new binding/version. Never resolve an old token to the newest grant by user/client/workspace alone.
- Default to uncached positive authorization reads. Database failures return unavailable. Scope increases need explicit consent; narrowing and membership loss apply immediately.

Required cases: original valid bearer after disconnect; revoked refresh; refresh/reconnect cannot revive old JWT; one workspace consent racing another; CSRF/state/PKCE/issuer/audience failures; DCR abuse; unavailable DB; provider cleanup failure; permission loss at refresh and resource access.

**Done:** authenticated identity, current authorization, provider token lifecycle, and connection state are independently correct. No token-cache manipulation is used as proof of server revocation.

### WP-05 — Enforce authorization across API, MCP, and services

**Dependencies:** WP-02, WP-03, WP-04.

Tasks:

- Inventory every route/service accessible to API keys, OAuth, device sessions, and browser sessions. Include compatibility aliases, batch routes, downloads, and operation replay/status.
- Extend shared authorization with deterministic operation/target/limit checks. Preserve fresh workspace membership, role ceilings, and RLS.
- Build parity tests proving the same principal/input has the same outcome through REST, CLI, HTTP MCP, stdio MCP, and supported browser execution.
- Apply restrictions to both current and legacy route versions for any credential bound to a grant. A legacy endpoint must not escape a narrower connection.
- Keep native HTTP tool handlers as adapters to the authorized service; do not forward LyraShield credentials outside the intended first-party resource boundary.
- Replace normal delegated MCP out-of-band review with the shared operation decision. Preserve exact-input approval/claim/replay for reviewed mode.
- Do not make local `allowMutations` or deployment environment flags authorization authorities. Migrate existing broad automation consumers deliberately; never globally flip every credential to delegated access.
- Normalize domain error codes in shared schemas, including auth required, revoked connection, lost membership, operation/target denial, budget denial, input conflict, and unavailable dependencies.
- Use proper HTTP authentication challenges; separate invalid token from insufficient permission. Preserve structured MCP errors and bounded matching text output.
- Update tool/plugin instructions so an authorized delegated call does not tell the agent to visit Review Queue. Never mark a mutating tool read-only to suppress host prompts.

**Done:** all five existing mutating tools execute without LyraShield per-action prompts under valid grants; all out-of-grant operations fail through every equivalent entry point; reviewed mode still works.

### WP-06 — Connection, API-key, CLI, and recovery UX

**Dependencies:** WP-04, WP-05; compose WP-01 rather than duplicate it.

Tasks:

- Build one resumable connection flow with client identity, workspace, target scope, Read only / Automate selected workflows, and relevant limits. Explain the actual permissions being granted.
- No-cost workflows require no budget form. Paid workflow consent uses existing customer-facing allowances and entitlements, not internal model cost. Reuse valid ownership/installation proof.
- Add connection list/details, current capability summary, pause, revoke/disconnect, and explicit scope-change/reconnect actions. Prevent the delegated credential from changing its own grant.
- Compose existing CLI login/install/doctor into the proposed `connect` command. Keep old commands compatible. Mark proposed flags as implemented only after executable help/tests exist.
- Provide authorization-code/PKCE interactive automation login. Keep existing device login read-only unless the provider's full device grant is actually implemented and tested; do not relabel a session token as refresh-capable OAuth.
- Validate API keys and workspace before reporting login success. Support protected stdin/env input, per-key expiry/revocation, and controlled rotation that preserves limits.
- Doctor reports configuration, activation, network/discovery, authentication, grant, workspace read, and unresolved host trust separately. It performs no billable scan by default.
- JSON output contains stable codes and recovery URLs; terminal prompts go to stderr; noninteractive commands never hang on hidden TTY consent. Preserve gate command exit codes.
- Cover cancellation, browser unavailable, lost callback, wrong workspace, zero targets, revoked GitHub installation, offline mode, expiry, back/refresh, and retry.

**Done:** a fresh user can complete one connection and an authenticated read without hand-editing OAuth metadata; an authorized private report runs with no second LyraShield consent screen.

### WP-07 — Registry and version-specific compatibility corrections

**Dependencies:** WP-01 interfaces; final delegated receipts require WP-05/WP-06.

Tasks:

- Use the research document's official-source matrix as the starting index. Re-read current vendor docs and test supported versions before changing a renderer.
- Add surface/version/OS/transport/auth capability records and separate documentation, package-conformance, and live-runtime evidence.
- Correct the Zed local schema and remote capability only against version-specific proof. Review understated remote support in Amp, Devin CLI, JetBrains, and Kiro.
- Separate Claude Chat from Claude Code; Devin hosted/Local/CLI; Codex Desktop/CLI/IDE; JetBrains AI Assistant/Junie; OpenCode desktop/CLI. Preserve public IDs with aliases where necessary.
- Keep Pi on its supported CLI/extension workflow; do not invent native MCP. Aider's native MCP remains unestablished unless new owner evidence proves it.
- Store exact setup/trust/reconnect instructions and known defect version ranges. A native OAuth feature in docs does not override a failing live refresh/callback receipt.
- Generate integration cards, install commands, diagnostics, and support claims from the same registry. Do not count plugin aliases as independent fully accepted clients.

**Done:** each advertised path has an honest capability and evidence record; generated output passes the actual selected client schema, not merely a snapshot of existing output.

### WP-08 — Installers, plugins, bridge fallback, and upgrades

**Dependencies:** WP-07; WP-01/WP-05 for the final credential-aware path.

Tasks:

- Preserve existing JSON/JSONC/TOML/YAML merge, backup, secret normalization, allowlisted vendor commands, and atomic write helpers.
- Detect the exact host and select its accepted path: native HTTP OAuth first, credential-aware LyraShield stdio where needed, existing pinned bridge for explicit version-bounded defects.
- Store no tokens in project config or package artifacts. Do not copy native client token caches between applications.
- Handle callback-port conflicts before starting OAuth. Respect exact preregistered ports; choose/register another only when the provider/client contract permits. Do not kill unrelated listeners.
- Correct the prior universal port-3846 documentation claim using exact installed bridge behavior; upstream derives ports from server identity. Preserve the historical observed collision as historical evidence.
- Register and activate plugins through each host's supported mechanism. Distinguish configured, installed, active, authenticated, and accepted.
- Update the product-owned generator; export marketplace artifacts reproducibly with exact source/package provenance. Verify hashes, file set, modes, no undeclared extras, and clean publication source.
- Publish only after source merge and released package availability under the existing release procedure. Do not manually patch generated marketplace output.
- Test upgrade from a known previous version and rollback. Compatible upgrades preserve consent; capability expansion must not inherit broader authorization automatically.

**Done:** clean installation and actual activation work on each declared path; no universal bridge/new daemon is introduced; old/new packages negotiate a compatible fail-closed contract.

### WP-09 — WebMCP execution and browser boundaries

**Dependencies:** WP-05/WP-06.

Tasks:

- Keep the existing page-scoped adapter and feature detection aligned with the selected browser/spec version. Check actual origin-trial/flag, origin isolation, and Permissions Policy requirements.
- Preserve prepare-only tool behavior and names. Add separately named delegated execution tools instead of silently making a form-preparation tool submit.
- Execute through the same authenticated server services; page state and tool annotations are not authorization.
- Represent a browser grant as session/workspace-bound unless a protocol establishes trustworthy agent identity. Do not trust a request-supplied connection ID or agent name.
- For meaningful confinement, use a session-wide automation ceiling across mutation routes or an isolated automation session without broader ambient credentials. If the browser retains unrestricted user-session access, do not claim that a narrow tool grant confines the entire browser agent.
- Preserve same-origin mutation/CSRF controls, secure cookies, input/output limits, and evidence allowlists. Keep cross-origin tool delegation disabled absent a supported use case.
- Unregister/refresh tools on workspace switch, permission loss, logout, navigation, and page restoration. Revalidate on invocation even when a tool was previously listed.
- Show operation progress and server-owned execution receipts in existing UI/activity components; distinguish prepared, applied, retested, verified, and accepted-risk states.
- Verify keyboard flow, focus restoration, announcements, reduced motion, mobile/desktop layouts, and unsupported-browser fallback.

**Done:** browser automation obeys the same grant, produces truthful receipts, and works without hidden submit clicks or unsupported universal-browser claims.

### WP-10 — Public edge reliability and observability

**Dependencies:** functional endpoints from WP-04/WP-05.

Tasks:

- Inspect current Cloudflare/ingress/runtime configuration and failure receipts before changing rules. Distinguish DNS/TLS, edge challenge, origin auth, callback, and application errors.
- Exercise public OAuth discovery/code/token/revoke and MCP initialize/list/call/status through both local and hosted client routes.
- Verify private/no-store behavior, auth challenges, header preservation, request/response limits, streaming completion, timeout, and rate-limit handling.
- Classify HTML edge challenges as edge failures, not invalid credentials. Never fix this by globally disabling WAF or adding a second interactive authentication gateway.
- Add only narrow, evidence-supported machine-route changes, preserving application auth and abuse controls.
- Reuse logging/metrics for sanitized connection, client version, operation/request IDs, result codes, latency, retries, and restoration. No raw token, prompt, evidence, or PKCE logging.
- Measure baseline and candidate auth overhead, first-read latency, refresh success, reconnect rate, and edge failures. Set justified production SLOs after measurement.

**Done:** accepted public paths preserve protocol behavior through the edge, with correlated evidence and actionable diagnostics.

### WP-11 — Native lifecycle acceptance for every supported surface

**Dependencies:** candidate packages and deployed revision from WP-01–WP-10 as applicable.

Use section 9's client ledger and section 10's procedure. Run the six selected desktop hosts first, then every advertised supported path. Do not equate terminal protocol proof with desktop proof. Record blocked accounts/models and continue other work.

**Done:** every full-support claim has install, read, delegated write, negative authorization, natural refresh, valid-token revocation, permission loss, reconnect, restart, and actual upgrade receipts for its exact tuple. Unsupported cases are explicit; they cannot be counted as passing supported features.

### WP-12 — Release, migration, documentation, and closeout

**Dependencies:** reviewed engineering changes; rollout stages gated by relevant acceptance.

Tasks:

- Use the release sequence in section 12. Record exact PR-head CI, merged-main CI, package hashes, deployment digest, traffic, and runtime proof separately.
- Preserve reviewed connections and old approval history; require explicit upgrade to delegated authorization. Migrate broad API-key behavior without letting grant-bound keys select an old bypass.
- Update product/UI/tool descriptions and `AGENTS.md`, `PRD.md`, `codebase.md`, `userguide.md`, integration guides, support tables, marketplace instructions, and operational runbooks after behavior ships.
- Do not overwrite old receipts. Link new evidence and correct overbroad present-tense claims.
- Revoke/remove only test-created connections and artifacts; restore LyraShield-only configuration changes and keep sanitized cleanup receipts.
- Retain exact blocked cases and required next actions. Do not call the whole program complete while required lifecycle evidence is missing.

**Done:** completion ledger is auditable; claims match deployed/package/client evidence; rollback preserves authorization restrictions.

## 6. Cross-cutting invariants

Use these as executable assertions wherever possible:

1. Effective authority never exceeds current role, credential scope, grant, target authorization, policy, or entitlement.
2. A credential bound to a grant stays restricted on every route and alias.
3. Old tokens cannot adopt a reconnected grant. No authority is inferred from client display name, tool annotation, or a request-supplied workspace/connection ID.
4. A grant version records the authorization actually used; a delegated operation is never recorded as individually human-approved.
5. After revocation commits, new admission against that binding fails. Already-admitted effects have explicit drain/cancellation semantics.
6. Same logical operation and idempotency key never intentionally execute twice; ambiguous external outcomes require reconciliation.
7. Shared usage limits hold under concurrency and key rotation; failures do not reset or bypass allowance.
8. Evidence and current gate applicability are unchanged by automation. No scan absence becomes proof of remediation.
9. An authorization read failure cannot reuse cached success. A host connected indicator cannot become an acceptance receipt.
10. A new scope, target, operation, or privilege is never silently enabled by refresh, install, update, or reconnect.

## 7. Required regression matrix

Assign stable case IDs in tests and receipts. Print IDs/assertions, not unredacted fixture values.

| Group   | Minimum cases                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRED    | Same access/new refresh; new expiry; two processes; lock timeout/crash; logout race; unreadable store; env precedence; origin mismatch; missing expiry; stdio request after expiry                |
| OAUTH   | PKCE/state/issuer/audience negatives; malformed callback; native client metadata; concurrent workspace consent; DCR abuse; refresh transient/permanent failures; stable signed connection binding |
| GRANT   | Read-only write; wrong operation/target/tenant; expired/paused/revoked grant; role downgrade; removed member; target identity changed; policy narrowed; agent self-escalation                     |
| REVOKE  | Original valid access token denied; refresh denied; new connection works; old token stays denied; provider cleanup fails; DB unavailable; revoke races admission                                  |
| EXEC    | Same key replay; changed input conflict; duplicate queues; crash recovery; response lost; revoked replay/download; aggregate allowance; intentional second operation                              |
| PARITY  | Every mutation through REST/current+v1, SDK/CLI, HTTP MCP, stdio, applicable browser tool; same operation semantics and machine-readable reason                                                   |
| TOOLS   | All 14 schemas; five mutation mappings; text/structured success/error/reviewed-pending/replay; annotation accuracy; output bounds; malicious tool arguments                                       |
| INSTALL | Vendor-schema conformance; platform paths; private credential references; JSONC preservation; activation; callback collision; dry run; uninstall; version-specific fallback                       |
| WEB     | Available/unavailable API; trial/flag state; CSRF; workspace switch; stale closure; restore/navigation; ambient-session boundary; keyboard/focus/mobile                                           |
| RELEASE | Old/new app compatibility; legacy keys/reviewed mode; restrictive grants on old routes; exact-release client calls; scope expansion on upgrade; safe rollback                                     |

Maintain a table mapping every invariant and regression to its runnable test or native receipt. A skipped test does not satisfy a required case.

## 8. Verification commands and database requirements

Inspect current workflow scripts before copying commands; paths and flags may change. Use Node 24+ and the repository's pinned package manager. Never load production database credentials into a local test run.

Current fast baseline command:

```sh
pnpm exec vitest run \
  packages/credentials/src \
  packages/agent-registry/src/__tests__ \
  packages/auth/src/oauth-resource.test.ts \
  packages/auth/src/oauth-workspace.test.ts \
  packages/auth/src/session-api-key.test.ts \
  packages/mcp/src/credentials.test.ts \
  packages/mcp/src/server-approval.test.ts \
  packages/mcp/src/remote-approval.test.ts \
  packages/sdk/src --reporter=dot
```

Add the new regression files and the affected remote-approval, route, database, CLI, browser, and packaging suites. The baseline command alone is insufficient for implementation acceptance.

Verified existing root commands include:

```sh
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test:core
pnpm build
pnpm test:e2e
pnpm format:check
git diff --check
```

Run the relevant package checks per focused PR, then the coordinated full integration checks on the combined candidate. Avoid repeating expensive full builds without a new change or unresolved concern. Check new untracked files explicitly because `format:check` enumerates tracked files.

For database work, reproduce `.github/workflows/ci.yml`'s PostgreSQL/migration/Redis setup in an isolated local test environment. That workflow creates `app_runtime_ci` with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOBYPASSRLS`; inspect the current workflow for exact grants and environment variables. Do not use its administrative migration connection as the application's runtime connection.

Run the applicable `packages/db/src/rls*.test.ts`, API-key RLS tests, new connection/operation runtime tests, and browser tests under the restricted role. Use the migration/system role only for fixture setup and authorized administrative work. Record `rolsuper` and `rolbypassrls` readback and test skip counts. Test both cross-tenant denial and successful same-tenant writes through normal services.

For migrations, verify current schema drift checks with an isolated shadow database, apply forward migrations, then test old and new application compatibility. Never use `db:push` as a production migration substitute.

## 9. Client acceptance inventory

Create one row per actual surface/version/OS/transport. The names below are the mandatory inventory seed; split families as needed. Registry aliases must not inflate acceptance totals.

| Priority  | Client/family             | Required distinction                                     |
| --------- | ------------------------- | -------------------------------------------------------- |
| First     | Codex                     | Desktop first; CLI and IDE are separate receipts         |
| First     | Claude Chat Free          | User-selected custom connector; not Claude Code          |
| First     | Devin                     | Local desktop first; hosted and CLI separately           |
| First     | Antigravity               | Installed desktop; record direct versus bridge           |
| First     | OpenCode                  | Desktop first; CLI and native/bridge status separately   |
| First     | Hermes                    | Desktop first; CLI version alone is insufficient         |
| Remaining | Claude Code               | Supported desktop host/account; entitlement may block    |
| Remaining | Cursor                    | Desktop and hosted agents                                |
| Remaining | VS Code / Copilot Chat    | Config activation, host trust, native query              |
| Remaining | Cline                     | CLI and supported IDE extensions                         |
| Remaining | Kilo Code                 | Actual advertised host variants                          |
| Remaining | Zed                       | Version-specific local schema and remote OAuth           |
| Remaining | Gemini CLI                | Native CLI workflow                                      |
| Remaining | JetBrains AI Assistant    | Own transport/auth receipt                               |
| Remaining | Junie                     | IDE and CLI; not AI Assistant's receipt                  |
| Remaining | Amp                       | Local/hosted definitions; Orbs only if advertised        |
| Remaining | Pi                        | Supported CLI/extension workflow; no invented native MCP |
| Remaining | OpenClaw                  | Explicit operator versus per-requester identity          |
| Remaining | GitHub Copilot CLI/plugin | Config and marketplace paths; count client once          |
| Remaining | Goose                     | Actual desktop/CLI extension paths                       |
| Remaining | Aider                     | CLI workflow; native MCP unestablished                   |
| Remaining | Roo Code                  | MCP settings and scoped host trust                       |
| Remaining | MiMo Code                 | Native local/remote and OAuth lifecycle                  |
| Remaining | Codebuff                  | Credential-aware stdio until native OAuth proven         |
| Remaining | Oh My Pi                  | Separate from Pi; callback and refresh                   |
| Remaining | Kiro                      | IDE/CLI/Web only as explicitly advertised/tested         |

Import the full registry at execution time and reconcile it against this list. Newly added supported entries must not be omitted. Do not install unrelated clients or upgrade every user's app merely to enlarge the matrix; prepare missing-environment requirements and complete available supported paths.

## 10. Native end-to-end procedure

For every supported tuple, retain these case results separately:

1. **N01 Install:** identify app bundle/executable, version, OS, package version/hash, server SHA/digest, transport, and auth mechanism. Install/activate through the official path in an isolated profile or reversible configuration.
2. **N02 Connect:** perform one explicit consent and record any separately controlled host trust step. Do not display/store secrets in receipts.
3. **N03 Read:** native workspace discovery, target query, and scoped assessment/status query.
4. **N04 Delegated write:** create a uniquely named private nonbillable report within the grant. Prove no additional LyraShield Review Queue approval occurred. Record server operation and report IDs.
5. **N05 Denial:** same client attempts an ungranted target/operation and receives a precise denial; verify zero new side effects in server evidence.
6. **N06 Replay:** repeat with stable logical identity and matching input; same result. Changed input with the same identity conflicts. Do not create another report to test replay.
7. **N07 Refresh:** cross two actual access-token lifetimes and perform fresh native queries. Correlate refresh/issuance metadata server-side. Artificially changing local expiry may supplement, not replace, this test.
8. **N08 Revoke:** revoke the isolated connection while the original bearer is still valid. Next native request and refresh must fail appropriately. Keep an unaffected connection as control.
9. **N09 Reconnect:** explicitly reconnect and complete a real tool read; original tokens remain denied. A connected icon is insufficient.
10. **N10 Permission loss:** use a controlled owner/member workspace. Downgrade/remove the test member; existing token denies newly forbidden actions and data. Restore through the separate owner; a new valid authorization must be explicit where required. Never remove the sole owner.
11. **N11 Restart:** observe the host and relevant children stopped, restart, then query. Avoid token-cache edits while a live process can rewrite them. Hosted clients use their documented equivalent lifecycle.
12. **N12 Upgrade:** update from a recorded supported release to the candidate, then read and delegated write. Test rollback separately. “Already latest” does not satisfy this case.
13. **N13 Recovery/cleanup:** test transient outage/retry, cancellation where applicable, and restoration of temporary configuration. Revoke test-only grants; retain sanitized cleanup proof.

If a required identity or host action is unavailable, finish all independent work and request the exact missing action with client, page, target workspace, intended effect, and recovery plan. Do not ask the user for credentials in chat. A sole-owner workspace is not a valid permission-loss fixture.

Automate deterministic transport tests and supported native UI steps. Keep human-controlled login/consent visible when required by the host. Record unsupported automation controls as limits; never fabricate native execution from shell output.

## 11. Minimum receipt schema

Use the existing evidence mechanism where possible. Suggested metadata, with no credential values:

```json
{
  "schemaVersion": 1,
  "caseId": "N08",
  "client": "codex",
  "surface": "desktop",
  "clientVersion": "<observed>",
  "osVersion": "<observed>",
  "transport": "remote-http",
  "authMode": "oauth",
  "packageVersion": "<released>",
  "packageHash": "<verified>",
  "sourceSha": "<tested>",
  "deploymentDigest": "<verified-or-null>",
  "authorizationVersion": 1,
  "startedAt": "<UTC timestamp>",
  "completedAt": "<UTC timestamp>",
  "expected": "Original valid bearer is denied after connection revocation",
  "observed": "<sanitized result>",
  "status": "PASS|FAIL|BLOCKED|UNSUPPORTED|NOT_RUN",
  "serverReceiptReferences": [],
  "restorationStatus": "<verified result>",
  "limitations": []
}
```

The example is illustrative, not a committed schema or a receipt. Actual timestamps/hashes must be observed. Store exact private workspace, connection, target, token fingerprints if necessary, and input bindings only in the private receipt store; public summaries use an allowlist. Never publish raw access/refresh tokens, authorization codes, PKCE values, source evidence, or private repository identity.

## 12. PR and release sequence

1. Ship reviewed credential regressions/fixes and version-specific contract corrections without expanding permissions.
2. Deploy additive connection/operation storage. Run migration/RLS/audit compatibility checks.
3. Deploy common enforcement in shadow/evaluation mode with no extra authority. Confirm every affected API route/alias/worker stage is covered.
4. Enable issuance only for controlled, newly consented delegated connections after enforcement is active everywhere. Missing bindings fail closed.
5. Release coordinated SDK/CLI/MCP packages and generated artifacts from merged source. Preserve old reviewed clients.
6. Verify nonbillable delegated reads/writes, edge behavior, revocation, and the six primary native clients on the exact candidate release.
7. Enable bounded scan/retest delegation only after reservation/eligibility/worker acceptance; any paid live test requires its own authorization.
8. Release accepted browser execution and remaining client paths as their gates pass. Publish only the supported capabilities with matching receipts.
9. Migrate legacy broad API keys deliberately, then retire obsolete bypass flags. Restrictive new credentials never get access to old bypass behavior during the transition.
10. Complete actual upgrades, cleanup, evidence reconciliation, documentation, and support-claim updates.

Use focused PRs following the dependency graph. If the user requires one product PR, develop reviewable commits/work packages and consolidate into one integration branch; test the combined head before merge. Do not squash away evidence references or merge cross-repository engine/marketplace history into the product repository.

Before merge, obtain independent review of authorization, refresh/revocation races, RLS/audit changes, execution identity, budgets, and browser ambient-session boundaries. Review findings require fixes or explicit evidence-backed disposition. Deployment follows the existing release workflow and authorization; do not infer that producing this handoff performs or approves deployment.

Rollback must preserve enforcement. Disable new delegated admission or return unavailable if the previous application cannot enforce grants. Never restore a permissive legacy route for grant-bound credentials. Additive migrations remain applied.

## 13. Product and developer experience acceptance

- One connection screen explains the actual target/operation scope and relevant allowance.
- An authorized workflow never receives an unnecessary LyraShield approval link, TTY prompt, or “please visit the dashboard” instruction.
- Missing host trust is identified as a host step with exact instructions, not misreported as a LyraShield auth failure.
- Connections and Doctor distinguish configured, activated, authenticated, allowed, executing, and completed.
- Error recovery tells users what changed: expired credential, revoked connection, lost role, target changed, allowance exhausted, or edge unavailable. It does not loop login for every failure.
- Ordinary refresh, restart, and compatible package upgrade retain consent and do not duplicate work.
- Private results remain scoped and redacted; public reports continue using the approved allowlist.
- Scores, findings, accepted risk, technical verification, and current readiness remain distinct.
- A code or report action cannot be described as deployed, verified, or secure solely because an agent tool returned success.

## 14. Completion ledger and closeout format

Create a durable ledger alongside the implementation evidence. Start all implementation rows at `NOT_STARTED`; do not copy prior research test counts into implementation acceptance.

| Work package             | Engineering state | PR/head SHA | Regression/checks | Deployed/released identity | Operational acceptance | Remaining limitation |
| ------------------------ | ----------------- | ----------- | ----------------- | -------------------------- | ---------------------- | -------------------- |
| WP-01 Credentials        | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-02 Storage/policy     | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-03 Execution/budgets  | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-04 OAuth/revocation   | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-05 Common enforcement | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-06 Connection UX      | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-07 Registry           | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-08 Distribution       | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-09 WebMCP             | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-10 Edge/metrics       | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-11 Native lifecycle   | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |
| WP-12 Release/closeout   | NOT_STARTED       | —           | —                 | —                          | NOT_RUN                | —                    |

Engineering states: `NOT_STARTED`, `IN_PROGRESS`, `CODE_VERIFIED`, `MERGED`. Release state and operational acceptance remain separate fields. Native case states: `NOT_RUN`, `PASS`, `FAIL`, `BLOCKED`, `UNSUPPORTED`. A failed or blocked required case prevents full acceptance of that supported tuple.

For each client tuple, add columns N01–N13 with receipt references. For each PR, retain exact-head CI IDs, failures fixed, required skipped checks, independent review, merge SHA, and merged-main CI. Record deployment/publish runs separately.

Final handback must state:

1. What users can now do automatically, and the exact remaining host-controlled steps.
2. What changed and the source/released/deployed identities.
3. Tests run and passed, required tests not run, and the reasons.
4. Per-client supported capabilities and lifecycle case results.
5. Cleanup/restoration status and any safe rollback action.
6. Every remaining external blocker, its concrete next action, and whether it blocks a client, a feature, or the full release.

The program is complete only when the five current mutations run under correctly bounded grants without repeated LyraShield approvals, restrictions hold across every entry point, refresh/revocation/concurrency work, distribution matches vendor contracts, and every published full-support claim has complete exact-release evidence.

## 15. Copy-ready task for the implementing agent

> Implement the complete LyraShield seamless integrations program in `docs/plans/2026-09-08-agent-integrations-coding-handoff.md`, using `docs/plans/2026-09-08-seamless-agent-integrations.md` for research and rationale. Read the current repository instructions and actual code first, fetch remotes, preserve all user files/worktrees, and verify current versions and open work before editing. Execute WP-01 through WP-12 in dependency order. Begin with reproducing and repairing credential persistence and long-lived stdio refresh; do not start by bypassing approvals. Build one server-owned delegated authorization contract used by API/CLI/MCP/WebMCP and worker admission, with current membership, scoped targets, durable operation identity, and existing usage/evidence enforcement. Preserve reviewed legacy behavior until explicit migration. Use focused codex branches and reviewed PRs; never push directly to main. Run relevant lint/typecheck/tests/builds, actual restricted-role database tests, browser acceptance, and exact-version native lifecycle tests. Continue independent work when a client needs user input. Do not recreate billing staging, make real payments, run unapproved billable scans, send invitations, remove a sole owner, or modify unrelated connections. Keep the completion ledger current with exact SHAs, CI, releases, deployment evidence, native receipts, cleanup, and blockers. Do not claim full compatibility or completion from unit tests, a connected icon, terminal-only evidence, or update checks. Finish with an evidence-backed handback covering every work package and supported client surface.
