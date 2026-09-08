# Seamless agent integrations: research and implementation design

Research date: 2026-09-08. Source baseline: `76587a358524ce884c43e3e63938d05e499be029`, fetched from origin before inspection. Status: proposed design, not implemented or operationally accepted.

Execution companion: [Detailed coding-agent handoff](./2026-09-08-agent-integrations-coding-handoff.md), including work packages, dependencies, test cases, and the completion ledger.

## 1. Product decision

**Connect once, authorize a clearly described workflow once, then let LyraShield execute that workflow without repeated LyraShield review or approval.** OAuth refresh, process restart, and ordinary compatible upgrades must preserve that authorization. Users can inspect activity, narrow access, pause automation, or disconnect at any time.

This changes the existing product rule that every remote OAuth mutation requires exact-input approval. It does not mean a read-only connection silently acquires write access, or that an agent can expand its own permissions. The first connection must explain what it authorizes. The user's request for research does not itself change production permissions.

Four authorities must stay distinct:

| Authority                        | What it controls                                                              | Desired experience                                                               |
| -------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| LyraShield connection consent    | Workspace, target access, permitted operations, limits                        | One explicit connection setup; no repeat approval within its grant               |
| Coding-agent host                | Whether its model can invoke a tool, execute a command, or modify local files | Configure documented, narrowly scoped trust once where supported                 |
| Connected service                | GitHub installation, repository permissions, organization restrictions        | Reuse valid existing access; explain missing authorization precisely             |
| Product eligibility and evidence | Scan eligibility, budgets, trusted retests, current gate applicability        | Automatic checks on every relevant action; an authorization never overrides them |

MCP does not mandate one user interaction pattern. Its tools specification recommends human oversight and confirmation; it does not require LyraShield to implement a second Review Queue for every already-authorized action. Persistent authorization, visible activity, cancellation, and revocation are the proposed product approach; host policy remains authoritative. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

**The support promise must be “automatic within the permissions you granted, on the tested client surface.”** Universal prompt-free behavior across third-party clients is not a promise LyraShield can enforce. Claude Chat Free, in particular, must not inherit capabilities or acceptance receipts from Claude Code or enterprise connector administration.

## 2. What the current code establishes

The monorepo already contains the main architecture. Reuse it rather than introduce an auth service, agent gateway, or orchestration framework.

| Finding                                                                                                         | Source inspected                                                                      | Consequence and proposed change                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote OAuth mutations always use out-of-band approval; API keys have a deployment-flag bypass                  | `apps/web/src/app/api/mcp/route.ts`, `remote-approval-gate.ts`                        | Replace credential-type-dependent behavior with a common, explicit connection grant. The flag's presence in source does not establish that it is enabled in production.             |
| Local MCP asks through elicitation, then TTY, or refuses; an environment flag bypasses that gate                | `packages/mcp/src/create-server.ts`, `stdio-transport.ts`                             | Let the server authorize delegated actions. Local prompt configuration must not be the authority for hosted writes.                                                                 |
| OAuth verifies JWT issuer/audience locally; its result does not include a revocable connection identifier       | `packages/auth/src/oauth.ts`                                                          | Add a server-owned connection binding and current status check. Signature validity alone cannot mean current permission.                                                            |
| Membership, role, and broad read/write scope are already checked in shared auth helpers                         | `packages/auth/src/session.ts`                                                        | Preserve these checks. Extend the same path with operation and target restrictions; do not duplicate tenancy logic in each transport.                                               |
| Direct report creation checks permission and creates the report without the MCP approval gate                   | `apps/web/src/app/api/reports/route.ts`                                               | Approval semantics currently differ by entry point. This is a design inconsistency, not evidence that the route lacks authorization. Restrictive grants must apply to REST as well. |
| Five mutating and nine read-only MCP tools have a catalog and shared annotations                                | `packages/mcp/src/tools.ts`, `tool-policy.ts`                                         | Extend that catalog for operation mapping; preserve existing names and schemas through a compatible transition.                                                                     |
| The CLI's OAuth login uses the device flow and intentionally receives read access                               | `packages/cli/src/commands/login.ts`, `packages/auth/src/oauth.ts`                    | Add a full authorization-code/PKCE connection flow for interactive automation. Do not pretend the existing device session already supports delegated writes.                        |
| Stdio resolves its credential once at startup and supplies a fixed bearer to the tool context                   | `packages/mcp/src/stdio-transport.ts`, `credentials.ts`; `packages/sdk/src/client.ts` | Add request-time credential resolution for long-lived processes.                                                                                                                    |
| CLI and MCP save refreshed credentials only if the access-token string changes                                  | `packages/cli/src/credentials.ts:77`, `packages/mcp/src/credentials.ts:49`            | Persist a changed refresh token or expiry even when the access token is unchanged. Add a regression before modifying this path.                                                     |
| Credential writes use a private temporary file plus atomic rename; refresh is not serialized across consumers   | `packages/credentials/src/index.ts` and both callers                                  | Keep atomic replacement; add a shared refresh/logout lock and a generation check. Atomic rename alone does not prevent two processes consuming one rotating token.                  |
| SDK accepts a static `apiKey` string, retries selected idempotent HTTP methods, and lacks a credential callback | `packages/sdk/src/client.ts`                                                          | Add an optional async bearer provider without breaking existing API-key consumers. Introduce explicit operation idempotency before retrying writes.                                 |
| Doctor checks reachability, credentials, and configuration presence                                             | `packages/cli/src/commands/doctor.ts`                                                 | Report actual transport, auth, grant, and read-query status separately. A file existing must not mean an integration works.                                                         |
| Browser scan tool prepares a form and requires human confirmation                                               | `apps/web/src/app/(dashboard)/dashboard/scans/scans-webmcp.tsx`                       | Preserve that tool's behavior. Add a separately named execution tool only when a browser automation grant is available.                                                             |
| Browser integration already feature-detects `document.modelContext` and unregisters with an abort signal        | `apps/web/src/lib/webmcp/register.ts`                                                 | Reuse this adapter and receipt store; add real-browser conformance and server-owned execution receipts.                                                                             |
| Registry has 30 entries resolving to 26 preferred cards, but only a coarse verification record                  | `packages/agent-registry/src/{agents,types,schema,index}.ts`                          | Add per-surface, per-version lifecycle evidence rather than promoting an entire client from one receipt.                                                                            |
| Zed entry emits a nested command object and exposes only stdio                                                  | `packages/agent-registry/src/agents.ts:257`                                           | Current vendor docs show a flat command/args/env shape plus remote OAuth. Reproduce against supported Zed versions, then version the renderer.                                      |

Current package versions inspected: CLI `0.2.4`, MCP `0.2.5`, Agent Plugin `0.1.24`, SDK `0.1.0`; Better Auth/OAuth provider is locked to `1.7.1`. These are source-package versions, not a new verification of every installed or deployed artifact.

The existing approval claim/replay implementation is useful: it binds canonical input, claims execution before side effects, and returns stored results. Preserve its historical records and reviewed mode. Do not turn a standing grant into a fake human-approved record for every operation.

## 3. Compatibility research and required client work

Every current registry client is represented below, with Kiro and the GitHub Copilot package path that contribute additional preferred cards. Claude Chat is an explicitly requested additional surface. JetBrains AI Assistant and Junie need separate acceptance even though the existing registry groups them.

These are documentation findings and recommended integration paths. They are **not new live-test receipts**. Vendor documentation is mutable; bind implemented adapters to the tested releases, OS, host, and package version.

| Client / surface                 | Official contract reviewed                                                                                                                         | Recommended LyraShield solution and acceptance focus                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                      | [MCP](https://code.claude.com/docs/en/mcp), [plugins](https://code.claude.com/docs/en/plugins)                                                     | Remote HTTP OAuth or registered marketplace plugin. Verify project trust, tool permissions, refresh, and desktop-host availability independently. Retain stdio for local workflows.                                                         |
| Claude Chat / Desktop Free       | [Connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)                                       | Public remote MCP custom connector; Free permits one. Traffic originates in Anthropic's cloud. Verify the Free account's actual tool controls; documented organization-wide Always allow controls are described for Team/Enterprise owners. |
| Cursor desktop and hosted agents | [MCP](https://cursor.com/docs/mcp), [plugins](https://cursor.com/docs/plugins)                                                                     | Native remote OAuth first. Desktop and hosted callbacks differ; configure and test each. Keep plugin activation separate from copying files.                                                                                                |
| Devin hosted and Devin Local     | [Hosted MCP](https://docs.devin.ai/work-with-devin/mcp), [Local reauthentication](https://docs.devin.ai/desktop/devin-local#mcp-re-authentication) | Treat as distinct surfaces. Native HTTP where accepted; pin and support the existing bridge for affected Local versions until direct callback and refresh pass.                                                                             |
| VS Code / Copilot Chat           | [MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)                                                                  | Keep `.vscode/mcp.json` with `servers`; use native HTTP OAuth when accepted. Server trust is a host-controlled setup step. Keep plugin discovery a separate acceptance track.                                                               |
| OpenAI Codex                     | [MCP](https://developers.openai.com/codex/mcp), [plugin packaging](https://developers.openai.com/plugins/build/plugins)                            | Marketplace activation or native HTTP OAuth. Verify Desktop, CLI, and IDE separately. Per-server/per-tool approval configuration is documented, but must match the installed host version.                                                  |
| Cline                            | [Configuration](https://docs.cline.bot/getting-started/config), [auto approval](https://docs.cline.bot/features/auto-approve)                      | Resolve the documented configuration root and overrides; separate CLI and IDE receipts. Scope trust to LyraShield tools, avoiding global approval of unrelated commands or tools.                                                           |
| OpenCode                         | [MCP](https://opencode.ai/docs/mcp-servers/)                                                                                                       | Native remote OAuth supports automatic and preregistered clients. Automate correct native-client registration for affected releases instead of making users edit a client ID. Test a real query after recovery, not just connected status.  |
| Kilo Code                        | [MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)                                                                                        | Use current `mcp` configuration and native OAuth. Test CLI/extension variants independently; preserve JSONC and environment-reference syntax.                                                                                               |
| Zed                              | [MCP](https://zed.dev/docs/ai/mcp)                                                                                                                 | Current docs support remote OAuth and flat local command fields. Update the stale renderer only after version-specific conformance; preserve a legacy adapter if its supported release needs it.                                            |
| Gemini CLI                       | [MCP](https://geminicli.com/docs/tools/mcp-server/)                                                                                                | Remote HTTP OAuth or stdio. Use documented server trust/tool restrictions for selected operations; ensure settings do not authorize unrelated tools.                                                                                        |
| JetBrains AI Assistant           | [MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html)                                                                                        | Docs establish stdio and Streamable HTTP. The reviewed page does not establish its complete OAuth lifecycle; retain stdio until native auth is demonstrated. Do not use Junie's result as its receipt.                                      |
| Junie IDE / CLI                  | [MCP configuration](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html)                                                             | Documented project/user `.junie/mcp/mcp.json`, local/remote servers, and OAuth authorization UI. Add explicit surface records under the existing JetBrains family.                                                                          |
| Amp                              | [MCP](https://ampcode.com/docs/customize/mcp)                                                                                                      | Native remote OAuth is documented; registry currently understates this with stdio only. Distinguish local config, hosted remote definitions, and Orbs. Shared hosted definitions can reduce repeated device setup.                          |
| Pi                               | [Usage](https://pi.dev/docs/latest/usage), [extensions](https://pi.dev/docs/latest/extensions)                                                     | Pi explicitly omits native MCP. Support the LyraShield CLI through its existing shell workflow; an extension is optional future work, not an invented MCP settings file.                                                                    |
| OpenClaw                         | [MCP](https://docs.openclaw.ai/cli/mcp)                                                                                                            | Prefer native HTTP OAuth. Choose shared operator versus per-requester identity explicitly; avoid giving unrelated chat senders one operator's workspace authority. Validate its credential lease and logout behavior.                       |
| Hermes                           | [MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)                                                     | Native OAuth is documented. Retain the pinned bridge on the affected desktop release until issuer/callback propagation and lifecycle pass natively. CLI success does not establish desktop success.                                         |
| Antigravity                      | [MCP](https://antigravity.google/docs/mcp)                                                                                                         | Native `serverUrl` OAuth is documented. Keep the supported bridge for the previously affected refresh path; retest direct behavior by version rather than permanently forcing the workaround.                                               |
| GitHub Copilot CLI               | [MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)                                            | Preserve documented local and HTTP configurations. Verify credential, scope, and trust behavior in the actual CLI release; do not infer it from VS Code.                                                                                    |
| GitHub Copilot plugin path       | [Plugin installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)                         | Use the marketplace/package mechanism. De-duplicate it against Copilot CLI when counting users/clients; verify activation, not file presence.                                                                                               |
| Goose                            | [Owner documentation](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md)                        | Use its extension installation mechanism. Verify local/remote transport, permission mode, and desktop restart. Do not replace the host's unrelated access controls.                                                                         |
| Aider                            | [Configuration](https://aider.chat/docs/config/aider_conf.html)                                                                                    | The reviewed configuration contract does not establish native MCP. Offer the standalone CLI workflow; label native MCP unestablished rather than claiming parity.                                                                           |
| Devin CLI                        | [MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)                                                                     | Docs now include remote HTTP and OAuth, while the registry exposes stdio only. Add a version-tested remote adapter; retain separate hosted/Local receipts.                                                                                  |
| Roo Code                         | [MCP and per-tool approval](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/)                                                  | Use its MCP settings and optional per-tool Always allow controls. Its global MCP auto-approval setting also affects those controls; show this dependency during setup.                                                                      |
| MiMo Code                        | [MCP](https://mimo.xiaomi.com/mimocode/mcp-servers)                                                                                                | Native remote OAuth, preregistered client options, auth/debug/logout commands. Keep local command-array/environment rendering and exact interpolation syntax.                                                                               |
| Codebuff                         | [MCP](https://www.codebuff.com/docs/tips/mcp-servers)                                                                                              | `.agents/mcp.json` supports local and HTTP servers. Native OAuth lifecycle is not established by the reviewed page; use the credential-aware stdio path until proven.                                                                       |
| Oh My Pi                         | [Owner MCP configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)                                                        | Native HTTP/OAuth with explicit callback options. Test callback ports and offline-access consent behavior; do not confuse it with Pi core.                                                                                                  |
| Kiro                             | [MCP configuration](https://kiro.dev/docs/mcp/configuration/)                                                                                      | Docs support local/remote servers, OAuth, and per-tool `autoApprove`. Existing generated stdio path remains usable; add remote only after exact-version proof. IDE/CLI/Web configuration scopes need separate records.                      |

### Required registry changes

Extend the existing types, renderer, and verification schema with:

- `surface`: desktop, IDE extension, CLI, hosted agent, or browser connector; `clientVersionRange`, OS, transport, and preferred install method.
- Supported auth: native OAuth, LyraShield credential-store stdio, API-key header, or a named/versioned bridge. Keep “supported by vendor,” “implemented by LyraShield,” and “accepted live” separate.
- OAuth client registration method, public/native classification, exact redirect rules, credential ownership, reconnect path, and known version-bounded defects.
- Host trust method and whether scoped unattended execution is documented, observed, unavailable, or unknown. Do not infer “no prompts” from OAuth support.
- Receipt references for install, reads, delegated writes, refresh, revocation, permission loss, restart, upgrade, and recovery. A partial record cannot produce a full-support badge.

Generate installer output, integration pages, plugin descriptors, doctor advice, and the public support table from this one registry. Preserve stable IDs and compatibility aliases; the count of registry cards is not the number of distinct fully accepted applications.

## 4. Reusable authorization instead of repeated review

### Connection experience

One connection screen should contain the client name, selected workspace, named targets, and two understandable choices: **Read only** or **Automate selected workflows**. The automation choice expands the relevant operations and limits on the same screen. Existing signed-in users should not have to visit another dashboard page just to finish setup.

Example proposed consent:

> Connect Codex to Acme / Checkout. Allow reading findings, creating private reports, recording fix proposals, and running scans/retests within the selected allowance. Repository writes and public sharing are disabled. You can pause or disconnect this connection from Integrations.

A user enabling paid scans chooses a per-run ceiling and a total allowance drawn from existing entitlements. The UI shows customer-facing usage units and charges, never internal model cost. A no-cost workflow needs no budget form. Existing target ownership and GitHub installation proofs are reused while valid.

After connection, an authorized private report call should immediately return its report or operation ID. It should not return an approval link. Scope expansion is a deliberate connection-settings change; invalid credentials require reconnect. Neither becomes a repeated approval chore disguised as a different screen.

### Server-owned grant

Add a small versioned `AgentConnection` record under workspace RLS, referencing existing identities and credentials. Suggested fields:

- `id`, `workspaceId`, `userId`, credential kind, OAuth client/session or API-key binding, and server-verified surface metadata where available.
- `authorizationVersion`, schema version, status (`ACTIVE`, `PAUSED`, `REVOKED`), creation/consent time, optional expiry, revocation time.
- Explicit allowed operation IDs and target IDs; repository/branch restrictions only for enabled repository writes. Bind target scope to the target identity so replacing a target's repository cannot inherit authorization silently.
- Versioned limits: permitted scan profiles, concurrency, per-operation and period allowance, and expiry/reset semantics. Validate through Zod; money uses existing Decimal policy.
- Consent actor and policy snapshot reference. Operational receipts identify the authorization version used; they never claim a human approved each action.

Use the existing OAuth consent records, API-key model, membership/permission helpers, scan eligibility, audit service, and queue. Do not store another copy of access or refresh tokens in this record. A browser automation connection is session/workspace-bound; a client-supplied agent name is display information, not an authenticated identity.

JWTs for the new flow carry an opaque connection ID and authorization version as signed claims. Refresh preserves this binding. Revocation and reconnect create a new binding or version; looking up the newest grant merely by `(user, client, workspace)` would risk reactivating old tokens and is prohibited.

Introduce an explicit automation consent version/scope, for example `lyrashield.automation`, alongside current read/write compatibility scopes. The new scope alone is insufficient: the active server grant supplies operation, target, and limit constraints. Do not silently reinterpret an old `lyrashield.write` token as consent to unattended execution.

### One decision at every execution boundary

Effective authority is the intersection of current membership/role, credential scopes, connection grant, workspace policy, target authorization, and current product eligibility. The most restrictive rule wins. An LLM never interprets consent or decides whether an operation fits a grant.

Extend shared auth/domain services with an operation check, conceptually:

```ts
authorizeAgentOperation({ principal, operation, resource, input, now })
```

All REST mutations reachable by a delegated credential call it; so do MCP, CLI requests, browser execution routes, and worker admission. Authenticate the connection from the bearer or browser session, never from an unsigned request field. Map each existing tool to a canonical operation in the current tool catalog. Tool aliases map to the same policy and audit action.

For new delegated credentials, a missing binding fails closed across both old and new route versions. The MCP adapter may preflight to improve errors, but the service handling the side effect owns enforcement. Do not turn `allowMutations: true` or an environment variable into a server authorization bypass.

REST currently reuses the hosted MCP bearer on the same application. Document that protected-resource boundary explicitly. For this phase, keep the existing issued audience and allow only intended first-party API operations using it; do not weaken audience validation to make every token work everywhere. A separate API audience later requires separately issued tokens and metadata. Never pass LyraShield tokens to GitHub, models, or arbitrary outbound URLs.

### Operation policy

| Workflow                                                              | Can run without further LyraShield review?                                                  | Required existing or one-time authorization                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Read targets, findings, status, current readiness                     | Yes                                                                                         | Read access and current target/workspace membership                                                                        |
| Create a private report                                               | Yes                                                                                         | `report.create`, authorized source scope, bounded rate                                                                     |
| Record a fix proposal                                                 | Yes                                                                                         | Finding belongs to allowed target; proposal stays proposed                                                                 |
| Start scan / PR assessment / retest                                   | Yes                                                                                         | Target ownership, selected modes, valid source identity, eligibility, reserved allowance                                   |
| Produce a fix plan                                                    | Yes                                                                                         | Read permission; any separately metered generation remains budget-bound                                                    |
| Open or update a fix PR                                               | Yes, when separately selected during connection setup                                       | Existing GitHub installation, explicit repository/branch constraints, server-generated patch, current patch/source binding |
| Merge a PR, deploy, publicly share, or accept risk                    | Only if the product implements and the user explicitly delegates that exact operation class | Separate explicit capability; preserve evidence/disposition semantics and external-service policy                          |
| Change billing, issue credentials, change membership, delete accounts | Outside the coding-workflow grant                                                           | Existing account/admin paths; never inherited from generic read/write automation                                           |

Do not add unsupported operations merely because they appear in this future policy table. Start with the five existing mutating MCP tools. Preserve exact-input review for users/workspaces choosing reviewed mode and historical pending requests.

## 5. Idempotent automation and reliable execution

Repeated prompts currently obscure another requirement: removing the Review Queue also removes its execution claim and replay record from the normal path. Replace that mechanical protection before removing the interaction.

Use existing operation-specific idempotency where available. For remaining agent mutations, add an `AgentOperation` record with connection/workspace, canonical operation, idempotency key, canonical input hash, authorization version, status, result reference, and timestamps. Enforce a unique connection/operation/key tuple. Keep result payloads bounded and sanitized.

- Reusing the same key and input returns the existing operation/result; different input returns a conflict.
- An intentional second run gets a new key. Deduplicating solely by input forever would prevent legitimate repeated scans or reports.
- CLI and SDK generate/persist a key for one logical action before its first network request. MCP tools expose an optional key for caller retries and return the operation ID immediately. A lost first response without a caller key is ambiguous; offer operation lookup/reconciliation, not a false guarantee of exactly-once delivery.
- Authorize, claim, reserve usage, and enqueue with the existing transactional/outbox pattern where available. Otherwise add the smallest durable handoff needed for recovery. An acknowledged operation must not disappear between database commit and queue enqueue.
- A worker rechecks grant and target eligibility immediately before an unstarted external action. No new action starts after revocation commits. In-flight work has explicit safe cancellation/drain semantics; already-sent external effects cannot be retroactively erased.
- Use existing BullMQ scan IDs, metering, settlement, and orphan recovery. Do not replay ambiguous paid jobs or introduce a second queue authority.
- Reserve maximum authorized consumption atomically across concurrent actions; release unused reservations and settle actual usage through the existing ledger. Enforce aggregate limits across all clients using the same allowance, including when key rotation overlaps.
- A revoked caller cannot retrieve private stored results simply because it knows an operation ID. Recheck access on status, replay, and download.

Return quickly for long operations, with a stable operation/scan ID, state, next poll time, and result link. Use existing status endpoints first; optional MCP tasks/progress are enhancements only when client capability is negotiated. A scan finishing does not automatically mean findings are verified or a release is ready.

## 6. OAuth, token storage, refresh, and disconnect

### Protocol contract

Keep the existing issuer, canonical resource, Better Auth integration, and Streamable HTTP endpoint. Target the dated MCP `2025-11-25` authorization contract while recording negotiated versions for older clients. It supports preregistration, client metadata documents, and DCR; these are compatibility options, not permission grants. Add metadata-document discovery only when the installed provider implementation and SSRF-safe fetching are verified. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

Preserve PKCE S256, state binding, exact callbacks, native loopback rules, issuer response validation, and audience checks. Do not suppress issuer validation to accommodate a broken desktop callback. Use a tested native version or supported bridge. [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700), [native-app OAuth](https://www.rfc-editor.org/rfc/rfc8252), [issuer identification](https://www.rfc-editor.org/rfc/rfc9207)

Dynamic client registration must be bounded and validated. Public native clients must not receive a supposed confidential secret embedded in a shared plugin. Names, logos, and arbitrary client metadata do not establish vendor identity. Pre-register documented hosted callbacks where appropriate; automate supported native registration without asking users to hand-edit client IDs.

Separate signed OAuth transaction state from mutable “active workspace” UI state. Two simultaneous client logins must not change each other's consent binding. Persist workspace, intended connection, requested capability set, return destination, and expiry in a server-owned authorization transaction. The consent submission may narrow requested authority, never expand it invisibly.

### Request-time credential lifecycle

Extend `@lyrashield/credentials`, not a new daemon:

1. Select a credential profile by normalized origin, account/workspace, and connection. Preserve explicit environment precedence. Never send a stored production bearer to an overridden arbitrary origin.
2. Before each SDK request, obtain a currently usable token. Native HTTP clients own their refresh; CLI and credential-store stdio use the shared implementation.
3. Serialize read/refresh/write/logout under a cross-process lock. Re-read under the lock; include bounded wait and stale-lock recovery. Atomic rename remains the write mechanism.
4. Persist every changed credential field, including refresh token and expiry. Preserve issuer, client ID, resource, scopes, and connection binding in the versioned credential profile.
5. If expiry is missing, do not assume the token remains valid indefinitely. Use supported token metadata/introspection and one bounded authentication-recovery attempt.
6. Separate transient timeout/429/5xx from `invalid_grant`. Preserve credentials on transient failures; retry with bounded backoff. Reauthentication is appropriate only when the grant is unusable.
7. A refresh response cannot resurrect a logged-out generation. Clear only the affected profile. Do not delete every agent's credential cache.
8. Environment access tokens are immutable and may expire. For unattended CI prefer a revocable scoped API key initially; do not promise refresh without a refresh-capable credential.

Add a backward-compatible optional `getAccessToken`/credential provider to the SDK. Refresh at most once for an authenticated request rejected with an appropriate invalid-token signal, then retry only when safe. Unsafe mutations require their original idempotency key. Never refresh-loop on a role denial, budget denial, or generic HTML edge error.

Current private-file storage can support the first implementation with strict permissions, symlink checks, redaction, and atomic writes. Prefer OS credential storage where a reliable existing runtime facility is available; do not introduce an untested keychain dependency to unblock the core fix. Never copy native clients' refresh tokens between applications.

### Immediate revocation

Better Auth's documented behavior distinguishes opaque tokens from self-contained JWTs: revoking a JWT access token directly is unsupported; ending a session can affect introspection, but local signature verification alone does not perform that lookup. [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)

Recommended minimal design: retain the existing JWT provider, and check the signed connection binding against current server state at every protected request, alongside membership. Disconnect marks the connection revoked before removing provider refresh/consent state. The LyraShield revocation barrier works even if provider cleanup must retry. Do not change the standard revocation endpoint to claim a token was revoked when it was not.

Avoid cached positive connection status for the first release. A database error returns unavailable, never cached approval. If latency later requires a cache, define a measurable revocation delay and enforce invalidation; do not call delayed invalidation immediate. Opaque tokens plus supported validation are an alternative if provider hooks cannot reliably maintain the connection binding, but replacing the provider is unnecessary without that evidence.

Test revocation with the original, otherwise-valid bearer still intact. Editing or expiring the client's access-token cache proves a different case. A refreshed browser session or cached consent must not silently resurrect a disconnected grant. Reconnect is an explicit user action and creates a new authorization binding.

## 7. CLI, API, and MCP experience

### Proposed CLI contract

The following commands describe additions; they are not available commands yet:

```text
lyrashield connect --agent codex
lyrashield connections list --json
lyrashield connections pause <connection>
lyrashield connections disconnect <connection>
lyrashield doctor --agent codex --probe --json
```

`connect` composes the existing login, workspace selection, install, and doctor implementations. Detect the client and version, choose its accepted transport, complete one connection screen, apply a narrowly scoped reversible configuration change, and verify a read. It should not run a billable scan to show a green check.

For automation, connection completion explicitly reports allowed workflows, targets, remaining allowance, and whether a host trust step remains. Headless execution never hangs on a hidden TTY prompt. Return a structured reason and a reconnect/settings URL only when action is actually required. Preserve current commands as aliases where practical; keep gate exit semantics 0/1/2 intact.

API-key setup validates the credential and workspace before reporting success. Accept secrets through protected input, environment, or stdin; avoid command-line arguments and generated project files. Existing keys remain hashed server-side; expose rotation with a bounded overlap, per-key revocation, expiry, and safe “last used” metadata. Rotation must not reset allowance or expand permission.

### Shared API contract

Add a versioned authenticated connection/capabilities response containing identity, permitted operations, target scope, current connection state, supported contract versions, and recovery actions. It must not expose secrets, private evidence URLs, or internal model cost.

Normalize error codes across SDK, CLI, MCP, and browser adapters. Suggested cases: `AUTH_REQUIRED`, `CONNECTION_REVOKED`, `WORKSPACE_ACCESS_REVOKED`, `OPERATION_NOT_GRANTED`, `TARGET_NOT_GRANTED`, `BUDGET_EXCEEDED`, `SOURCE_CHANGED`, `IDEMPOTENCY_CONFLICT`, and `UPSTREAM_UNAVAILABLE`.

- Invalid/expired bearer: HTTP 401 with a proper authentication challenge.
- Valid bearer but insufficient scope/role/grant: HTTP 403 with the applicable machine-readable reason; use the OAuth insufficient-scope challenge where appropriate.
- Conflicting request identity: HTTP 409. Rate limits: HTTP 429 plus Retry-After. Temporary dependency failure: HTTP 503.
- MCP preserves transport-level authentication errors and uses `isError` plus structured domain errors for tool failures. Do not turn every domain denial into a login loop.

Preserve the established public SDK/API shape through adapters; generate new operation schemas and documentation from shared Zod definitions. Do not require a new generic command language to call the existing fourteen tools.

### MCP tools and distribution

Keep stable tool names, accurate read/write annotations, bounded schemas, text plus matching structured output, and stored-result parity. An annotation is descriptive, never authorization. A tool labeled “record fix proposal” must not merge a PR or change a finding to verified.

For delegated mode, remove the normal `approvalId` round trip. Preserve it for reviewed connections and old pending requests. Change tool instructions and plugin skills together so agents stop advising unnecessary dashboard visits. Keep a stable catalog initially; if tool availability later changes dynamically, negotiate and test list-change notifications rather than assuming all clients refresh automatically.

Native HTTP OAuth is preferred when the exact client release passes. Credential-aware LyraShield stdio is the fallback for local hosts with no reliable native OAuth. Retain the existing pinned `mcp-remote` bridge only for documented version-specific gaps. This avoids maintaining a new bridge while the shared credential path is repaired.

Current upstream bridge documentation derives callback ports from the server URL and describes explicit-port behavior. The older audit's universal port-3846 statement is overbroad; replace it with the observed same-server collision and exact installed-version behavior. Separate credential directories do not guarantee separate callback ports. Probe/reserve the selected port before authorization, use exact registered callbacks, and never kill another host to acquire a port. [mcp-remote owner documentation](https://github.com/punkpeye/mcp-remote/blob/main/README.md)

Pin released packages, verify provenance/file hashes, and perform native activation after install. Never mark a copied plugin directory as installed. An ordinary compatible update preserves connections; a new operation or expanded scope needs a visible grant change. Provide rollback to a known working package without restoring revoked credentials.

## 8. WebMCP and browser automation

WebMCP is a browser tool surface, not a replacement for remote MCP or a background agent runtime. Chrome's current documentation describes an origin trial from Chrome 149 and a local testing flag; it also requires origin isolation and a `tools` Permissions Policy. A page visit is required for discovery. Do not advertise support in every browser. [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp)

The current draft exposes `document.modelContext`, so the source's API location is aligned with that draft. Keep feature detection and version-specific tests rather than following older examples using another global. [WebMCP draft](https://webmachinelearning.github.io/webmcp/)

Implement two explicit categories using the existing adapter:

- UI/read tools: navigate, explain, filter, or prepare forms; they retain current behavior.
- Delegated execution tools: call authenticated server routes under a browser automation grant, then update the same UI and activity receipts. They never click a hidden submit button or rely on the presence of a browser session as blanket permission.

A browser does not necessarily provide a trustworthy coding-agent identity to the page. Label this grant “Browser automation in this workspace/session” unless a supported protocol establishes a stronger binding. Server routes enforce its authority; the page cannot assert another agent's connection ID to inherit access.

Do not claim that a narrow WebMCP grant confines an agent that also controls an unrestricted authenticated browser session. For enforceable confinement, apply the automation ceiling to that session's mutations across all API routes, or use an isolated automation session with no broader ambient credential. Changing that ceiling belongs to the human connection-management path and is not exposed as an agent tool. If the product retains an unrestricted manual session, describe WebMCP restrictions as tool-surface limits, not isolation of the whole browser agent.

On workspace switch, logout, role loss, grant revocation, navigation, and page restoration, unregister or refresh stale tools and recheck permission on invocation. Retain same-origin mutation protection, CSRF controls, secure cookies, input/output bounds, and private evidence allowlists. Cross-origin tools and iframe delegation remain off unless an actual product use case is accepted.

Keep browser-controlled permissions intact. A server capability cannot remove browser prompts. On unsupported browsers, show ordinary UI plus the API/MCP option. Preserve keyboard navigation, focus restoration, live status announcements, reduced motion, and refresh/back recovery. Activity records should explain “Executed using the Checkout automation connection,” not “You approved this action” when no individual approval occurred.

## 9. Edge reliability and observability

Treat Cloudflare/ingress behavior as its own acceptance layer. A healthy origin does not prove a hosted client can complete discovery or stream a response through the public domain.

Test public discovery, OAuth authorization/callback/token/revoke, MCP initialize/list/call, REST status, 401/403/429, streaming, and body limits from local and hosted client paths. Record sanitized request IDs and edge identifiers to correlate failures. Detect an HTML challenge response and report an edge/network failure instead of a misleading “invalid API key.”

Review current route-specific caching, challenge, rate-limit, and proxy rules. Preserve application auth and abuse protection. Any machine-endpoint exception must be narrow and supported by observed failures; do not disable WAF globally or add another interactive gateway login to an already working OAuth flow.

Reuse the existing logger and metrics. Record connection ID, client/surface version, operation ID, reason code, latency, retry count, and outcome. Do not log tokens, authorization codes, PKCE material, raw prompts, or evidence payloads. Operator-only cost accounting remains separate from public telemetry.

Proposed acceptance targets, to measure rather than claim today:

- Zero LyraShield approval prompts for successful in-grant operations after setup.
- Zero silent scope expansion or cross-workspace/target access in negative tests.
- Every operation admitted after a revocation transaction commits is denied for that revoked connection.
- Fifty concurrent authorized requests do not duplicate a logical operation or exceed the shared allowance.
- At least two real access-token refresh cycles without a user prompt in refresh-capable accepted clients.
- Connection completion always shows a successful read or a precise unresolved setup step; never a false green indicator.
- Measure p50/p95 time to first read, authorization overhead, reconnect frequency, and setup abandonment before setting production latency SLOs.

## 10. Acceptance harness and truthful support claims

Reuse Vitest, PostgreSQL with actual RLS roles, Playwright, and native-host automation. Keep protocol tests deterministic and inexpensive; model-mediated native tests need separately bounded quotas. No new billing staging deployment is required for this work.

### Mandatory server and client-contract regressions

| Area               | Cases required before release                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grants             | Read-only cannot mutate; wrong operation/target/workspace denied; missing binding; exact expiry boundary; role loss; target identity changed; policy narrowed; agent cannot edit its own grant                                 |
| Grant lifecycle    | Revoke while access token remains valid; reconnect cannot revive old JWTs; pause/resume policy; database unavailable; provider cleanup failure; concurrent token refresh and revoke                                            |
| Refresh            | Same access token with changed refresh/expiry persists; two processes share one rotation; long-lived stdio crosses expiry; missing expiry; timeout/429/5xx recovery; `invalid_grant`; logout wins against an in-flight refresh |
| OAuth              | PKCE/state/issuer failures; audience mismatch; callback exactness; native classification; cancellation; simultaneous workspace consent; DCR limits; malicious metadata URLs; unknown client versions                           |
| API parity         | The same grant/input returns the same authorization outcome through REST, CLI, native HTTP MCP, stdio MCP, and browser execution; old route versions cannot escape restrictions                                                |
| Replay and budgets | Same key/same input replays; changed input conflicts; crash after claim; response lost after external effect; aggregate concurrent reservations; revoked status/read/replay denied                                             |
| Tool contracts     | All fourteen tool schemas; five mutation mappings; text/structured output on success, denial, pending reviewed mode, and replay; accurate annotations; bounded output                                                          |
| Installers         | Actual vendor schemas, JSON/JSONC/TOML/YAML preservation, private paths, filenames with spaces, hostile config fields, plugin activation, callback collision, reversible uninstall                                             |
| Browser            | Feature available/unavailable, origin-trial/flag configuration, workspace switch, page restore, CSRF, foreign iframe, stale closure, keyboard/focus/status behavior                                                            |
| Evidence           | Retest requests remain distinct from successful verification; missing/expired/revision-mismatched assessments cannot approve a release                                                                                         |

### Native lifecycle protocol

Run first on the six explicitly selected clients: Codex Desktop, Claude Chat Free, Devin Local, Antigravity, OpenCode Desktop, and Hermes Desktop. Claude Code remains a different, entitlement-dependent client; do not claim its acceptance from Chat. Then run the declared supported paths of every registry client before granting full support to each path.

For each version/OS/transport tuple:

1. Start from an isolated profile or a reversible LyraShield-only configuration change. Capture client/package/server versions and installed artifact identity.
2. Complete the supported native install/activation and one consent. Record separately any host trust prompt and LyraShield consent.
3. Perform workspace and target reads through the native interface.
4. Create a private, nonbillable test report under a delegated grant without visiting Review Queue. Change to an out-of-scope target/operation and prove denial with zero side effects.
5. Let the actual access token expire twice. Demonstrate native read/write recovery and server-correlated refresh without re-consent. Do not substitute editing a local expiry timestamp for this receipt.
6. Revoke the connection server-side while the original access token is still valid. The next native call must fail. Prove the old refresh token cannot mint usable access, and a browser session cannot silently restore the revoked connection.
7. Reconnect explicitly, then perform another real native read. A green “connected” icon or tool list is not enough.
8. Use an isolated member account in a controlled test workspace to test role downgrade and membership removal. Keep a separate owner for restoration. Never remove the sole owner; do not send invitations without the user's explicit authorization.
9. Quit and observe the host and relevant child process tree stop; restart and query. Do not edit token files while a process can rewrite them and call that a clean revocation test.
10. Upgrade from a known supported release to the candidate release, preserving the connection, then repeat read and delegated write. “No updates available” is not an upgrade test. Test rollback and a scope-expanding update separately.
11. Restore temporary settings, revoke test-only connections, and retain sanitized evidence. Existing user integrations stay intact.

For hosted clients, use the equivalent provider session/restart lifecycle rather than inventing a local process. For clients without native MCP, run the documented CLI workflow and label the receipt accordingly. Unsupported functionality is `UNSUPPORTED`; an unavailable account/model is `BLOCKED`, not `PASS`.

Receipts include test ID, client/surface/version/OS, package version and hash, source SHA/deployment digest, transport/auth method, connection authorization version, sanitized input hash, expected/observed outcome, server operation/request IDs, timestamps, restoration status, and limitations. Store private identities only in the private evidence store. Publish an allowlisted summary.

Earlier audit records are useful starting evidence but need these stricter distinctions. Refresh-token revocation is not immediate access revocation; native connected status is not a recovered query; a vendor update check is not an upgrade; a silently restored session needs a causal record before it proves intentional reconnect behavior. Keep old receipts historical rather than rewriting them into stronger claims.

## 11. Implementation sequence and release gates

Use focused `codex/` branches and reviewed PRs. The following sequence keeps changes small enough to verify while delivering the requested complete system.

| Step                                     | Concrete work / main files                                                                                            | Exit gate                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Refresh and contract corrections      | `packages/credentials`, CLI/MCP credential callers, SDK bearer provider, version-specific registry renderers          | Reproduce same-token persistence and long-lived expiry; concurrency/logout tests; vendor-schema conformance; no new permission behavior |
| 2. Add grant and execution storage       | Additive Prisma migration, `packages/db` services/RLS/audit, shared operation schemas/catalog                         | Old/new application compatibility, role isolation, idempotency/budget concurrency, immutable authorization binding                      |
| 3. Consent and common enforcement        | OAuth hooks/claims, consent UI, shared session/permission helpers, every reachable domain operation, worker admission | Grant cannot be bypassed through another transport or API version; valid-token revocation and member loss fail closed                   |
| 4. Seamless clients and distribution     | CLI connect/doctor, SDK, MCP adapters/instructions, registry and generated plugin artifacts                           | One consent and zero repeated LyraShield prompts for the five current mutations; correct structured replay; no global bypass required   |
| 5. Browser execution and integrations UX | Existing WebMCP adapter/hooks, connection settings, activity/recovery UI                                              | Real-browser acceptance, consistent server authorization, accessible setup/recovery, no hidden submit behavior                          |
| 6. Exact-release client acceptance       | All supported surface tuples, edge paths, native lifecycle harness and receipts                                       | Each published full-support claim has all required receipts; incomplete paths remain explicitly partial                                 |

Storage deploys first. Initially evaluate new authorization in shadow mode without granting additional access. Enable delegated mode only for newly consented versioned connections and controlled accounts; require enforcement everywhere before issuing their credentials. Existing OAuth write connections retain their reviewed contract until explicitly upgraded. Historical approvals remain readable and their already-executed results replay under current access checks.

Legacy API keys need a deliberate migration from broad role/scope semantics. Preserve documented access during a communicated transition, but never let a credential already bound to a restrictive grant select the legacy bypass. Do not use a global flag to convert every key to unattended authority. Eventually retire broad bypass flags after affected connections are migrated and tested.

Rollback disables new delegated admission or returns unavailable; it must not revert to an API path that ignores connection restrictions. A schema rollback is unnecessary for additive storage. Update `PRD.md`, `AGENTS.md`, `codebase.md`, user guides, marketplace instructions, and support claims when the behavior actually ships, not when this proposal is written.

New platform features, a new OAuth provider, a separate bridge service, arbitrary client plugins, and a universal autonomous agent runtime are not required. The simpler implementation is the existing architecture plus a server-owned grant, reliable credentials, operation receipts, and accurate adapters. Ship nonbillable delegated workflows first inside this full rollout, then scans/retests after the existing budget and eligibility integration passes.

## 12. Research validation and remaining evidence

This research inspected the current source paths above, the existing lifecycle audit, and official vendor/protocol documentation. It did not change production, native client configuration, billing resources, account membership, or grants. It did not run new native lifecycle tests or claim full compatibility.

Baseline command run against the inspected source:

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

Result: **14 test files, 229 tests passed**. This is a focused baseline, not PostgreSQL/RLS runtime, full build, native desktop, upgrade, or production acceptance. Existing passing tests do not reproduce all newly identified design gaps.

Open implementation decisions are narrow: exact supported client-version ranges, the installed provider's reliable connection-binding hooks, which existing transaction/outbox paths can own new operation receipts, and the user-facing scan allowance defaults. Validate these during their implementation steps. None requires replacing the architecture or postponing the credential fixes and nonbillable automation path.
