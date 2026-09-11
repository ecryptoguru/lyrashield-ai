# Wave E — Agent surfaces (MCP/CLI/plugin/SDK/integrations)

- **Baseline:** `main @ 3b289a43` (v16 dedupe manifest: `docs/security/review-2026-09-11.v16-dedupe.md`, v16 head `3fc40597`)
- **Files reviewed:** 135 production files — `packages/cli` (47), `packages/mcp` (10), `packages/sdk` (19), `packages/agent-rules` (14), `packages/integrations` (5), `packages/agent-registry` (5), `packages/agent-plugin` (4), `packages/cli-alias` (2), `packages/credentials` (1); plus 26 server-side files (MCP route + remote approval gate, connections, agent-approvals, OAuth metadata/consent/onboarding, sync auth/license/session, GitHub install/repo/webhook + install-state, fix-PR context/execution/route, api-auth, agent wizard, connection health, `packages/auth` oauth+session, `packages/db` agent-approval/authorization/connection/operation services); plus `action.yml` and `.github/workflows/lyrashield-scan.yml`. Test files excluded from findings and count.
- **Findings:** 3 (0 Critical, 0 High, 3 Medium)

## Findings

### [VULN-E-001] Git option injection via unvalidated `--base`/`--head` arguments in CLI diff commands (Severity: Medium)

- **Location:** `packages/cli/src/diff-core.ts:89` (`getChangedFiles`), `:109` (`getAddedLinesForFile`), `:141` (`getAddedLineNumbers`), `:175` (`getChangedFileContent` — `head` interpolated into the `git show` object spec). Reachable via `commands/gate.ts:39-57` and `commands/check-diff.ts` through `resolveDiffRange()`.
- **Confidence:** High (defect and sink are concrete; exploitation requires attacker-influenced ref arguments — consistent with the documented deployment model where coding agents invoke the CLI with parameters derived from repository/task content, the same reason this codebase ships a prompt-injection guard).
- **Threat actor:** T4 (supply-chain attacker targeting installed developer artifacts — e.g., a malicious repo/PR whose content an agent relays into `--base`/`--head`).
- **Issue:** User-supplied `base`/`head` values are placed directly into `git diff` argv (`execFile("git", ["diff", "--name-only", base, head], …)`) with no `--end-of-options` delimiter and no ref-shape validation. An argument beginning with `--` is parsed as a git option, not a revision.
- **Impact:** `lyrashield gate --base=--output=$HOME/.lyrashield/credentials.json` → `git diff --name-only --output=<path> …` redirects diff output to an arbitrary path — destroys stored credentials, overwrites shell rc/SSH files. Content is partially attacker-controlled: `--name-only` output is the changed-file list, and an attacker who authored the diffed commits controls those pathnames (git filenames permit spaces, so a crafted filename emits a valid `authorized_keys` line). Secondary path: `getChangedFileContent` interpolates `head` into `git show --no-pager "${head}:${file}"`, where a `--`-prefixed head is parsed as a `git show` option.
- **Evidence:** `diff-core.ts:89,109,141` — argv built as `[..., base, head]` with no delimiter; `resolveDiffRange` (lines 74-85) passes caller values through unvalidated; `gate.ts:12` declares `base`/`head` as free `string` minimist options. The repo's own `action.yml`/workflow uses `git rev-parse --verify --end-of-options` for untrusted refs (`lyrashield-scan.yml:79,83`) — the correct pattern is known but not applied in the CLI.
- **Fix:** Resolve refs through `git rev-parse --verify --end-of-options "${ref}^{commit}"` before diffing, and pass only the resulting 40-char SHAs; alternatively reject any `base`/`head`/`file` argument starting with `-`. Apply the same validation to `head` in `getChangedFileContent`.
- **v16Overlap:** false — v16 does not touch `packages/cli`.

### [VULN-E-002] `lyrashield login --key` places the API key in process argv (Severity: Medium)

- **Location:** `packages/cli/src/commands/login.ts:53-57` (`string: ["key"]`, `alias: { k: "key" }`), consumed at `:62`; the flag is advertised to users in the error at `:73` ("Pipe it to stdin or use --key").
- **Confidence:** High.
- **Threat actor:** T4 — the credential-management artifact leaks the `lsk_` secret through host-local exposure channels (co-resident processes reading `/proc/*/cmdline`/`ps`, shell history files, terminal scrollback, CI job logs).
- **Issue:** Supplying `lyrashield login --key lsk_…` embeds the long-lived workspace API key in the process argument list and in the invoking shell's history. Argv is world-readable on multi-user hosts and is persisted by every interactive shell; CI systems log command lines by default.
- **Impact:** Durable credential exposure outside the protected store (`~/.lyrashield/credentials.json`, 0600). The key grants the workspace's API-key scope until revoked — silent exfiltration path with no file access required.
- **Evidence:** `login.ts:53-56` defines `-k/--key`; `:62` assigns `parsed.key` directly. Safe alternatives already exist in the same function — stdin pipe (`:64-65`) and a hidden TTY prompt (`:11-22,67`) — so the flag is an unnecessary unsafe channel.
- **Fix:** Remove `--key`/`-k` (breaking change) or emit a deprecation warning steering to stdin/hidden prompt; document that the flag must never be used in scripts or CI (where it lands in logs). At minimum, scrub `process.argv` after read.
- **v16Overlap:** false.

### [VULN-E-003] Unpinned runtime package installs execute remote code in the distributed scan workflow (Severity: Medium)

- **Location:** `.github/workflows/lyrashield-scan.yml:173` (`pip install --quiet safety`, executed at `:178` via `safety check`) and `:156` (`npx pnpm audit`, which fetches `pnpm@latest` from npm when pnpm is not already on PATH — no `pnpm/setup`, `setup-node`, or corepack step exists in this workflow).
- **Confidence:** High on the mechanics; impact is conditional on an upstream package compromise (inherent to the supply-chain threat class).
- **Threat actor:** T4.
- **Issue:** The workflow SHA-pins every GitHub Action (`checkout`, `gitleaks-action`, `upload-artifact`, `upload-sarif`) but fetches and executes unversioned packages from PyPI/npm at scan time. It is `workflow_call`-consumable, so it runs inside *customer* CI with the customer's checked-out source and a job token holding `contents:read`, `pull-requests:read`, `actions:read`, `security-events:write`.
- **Impact:** A malicious `safety` or `pnpm` release executes arbitrary code in every consumer's CI run → exfiltrate private source, tamper with scan results/SARIF, or abuse the job token within its granted scopes. The package pin is the integrity boundary here and it is absent.
- **Evidence:** `lyrashield-scan.yml:156,173-178` — no version specifier, no hash checking, no signature verification; compare with the same file's SHA-pinned `uses:` entries at `:40,117,377,389`. The step's own comments show the run is treated as security-authoritative (fail-closed on scanner error, `:201-204`), raising the stakes of scanner integrity.
- **Fix:** Pin exact versions with hash verification (`pip install safety==X.Y.Z --require-hashes` against a committed requirements file; install pnpm via the SHA-pinned `pnpm/setup` action or `corepack prepare pnpm@X.Y.Z --activate`). Alternatively vendor the audit step into a pinned container image.
- **v16Overlap:** false — v16 workflow commits (`11d1a868`, `f6ee3d90`) touch `deploy-azure`, `ci`, and `configure-cloud-billing-admission` only.
- **Note:** Consolidated with Wave H finding H-004 (same defect reported independently).

## Needs Verification

- **Legacy credential files without `apiUrl`:** `resolveCredentials` guards stored creds by API-origin match, but if a `credentials.json` lacks `apiUrl` (hand-edited or written by an older version), a stored OAuth bearer could be sent to a `LYRASHIELD_API_URL`-controlled host. No shipping code path was confirmed to write credentials without `apiUrl`; residual risk low since env-var control implies local control.
- **Unbounded `expiresAt` on `POST /api/agent-approvals`:** client-supplied expiry is accepted without a server-side maximum (remote-MCP path uses a fixed 15-min TTL). A tenant could mint never-expiring approval rows — but execution still requires human approval + matching input hash, so impact is limited to approval-surface persistence; intended policy unclear.
- **Client-chosen `expiresAt` on `POST /api/connections`:** the consent state binds client ID/scopes/user but not expiry — a user can create far-future delegated grants. Self-directed (the consenting user authorizes their own agent); whether the platform intends a maximum grant lifetime needs confirmation.
- **Stale READY verdicts still exit 0 in `gate --verdict`:** `gate.ts:248-271` treats `state==="READY" && applicable` as exit 0 even when `staleness.current === false` (only annotates output text). Also, the caller chooses `--commit`, so an old READY verdict could be replayed against a newer tree — but the gate is advisory to the tenant's own pipeline (self-gating). Product intent unverified.
- **`safety check --file requirements.txt` on PR-controlled input:** whether the installed `safety` version follows `-r`/index directives inside the requirements file (redirecting its own resolution) is unverified — depends on upstream parser behavior.
- **Latent containment assumptions:** `resolveWithinProject` (agent-rules) and plugin `uninstallAgentPlugin` are safe only because registry paths are statically fixed; no independent containment check exists if registry entries ever become attacker-influenced. Hardening note, not a current vulnerability.

## Verified safe

- **Credential store:** dir `0700`/file `0600`, `O_EXCL` temp + fsync + atomic rename, env-over-file precedence, API-origin mismatch guard before transmitting stored creds, lock-serialized OAuth refresh that never resurrects deleted/changed credentials.
- **MCP server:** mutations blocked by default; `allowMutations` only for explicitly trusted contexts; sanitized args passed to approval gate and execution (no TOCTOU); atomic `APPROVED→EXECUTING` claim; CAS completion; bounded retries; prompt-injection guard (NFKC, zero-width, homoglyphs, URL/HTML entities, base64, leetspeak) runs before authorization; `lyrashield_check_diff` exemptions deliberate and documented.
- **Remote MCP + OAuth:** `lsk_`/OAuth bearer both verified live per request (issuer, audience, JWKS, claims, scopes, `azp`, connection status, expiry, `authorizationVersion`); revoke bumps version — stale tokens die even if status check were bypassed; pause fails live.
- **Connections:** HMAC-signed user-bound 15-min consent state; client ID/scopes must match signed state; display name resolved server-side from registered client (v16-hardened, noted for completeness); browser-only mutation routes reject API-key/OAuth sessions via `requireBrowserConnectionManager`; `withCookieMutation` enforces same-origin for cookie sessions.
- **Agent approvals:** canonical sorted-keys sha256 input hash; workspace-scoped lookups/mutations; atomic claim before side effects; replay-safe stored results; cross-workspace IDs fail closed; approve/deny require `agent.approve` + input-hash match.
- **Fix-PR execution:** all sensitive fields reconstructed server-side (diff, target, installation, baseCommit, implicated files, plan); patch scope validated against plan tier; checksum bound into approval; live default-branch SHA check; per-file fail-closed diff application; no auto-merge.
- **Operation ledger:** principal-bound idempotency (workspace+principalType+principalId+op+key), input-hash conflict detection, workspace+principal+version-bound status reads, sanitized reason codes.
- **Installers/plugin:** vendor allowlist (`claude`, `amp`); `execFile` only; static registry paths; symlink-ancestor checks; `O_EXCL`+fsync+rename writes; JSON/JSONC/TOML/YAML mergers preserve and re-verify the LyraShield key; export allowlist + symlink rejection; managed-block markers + checksums.
- **OAuth CLI flow:** HTTPS-only API URL (loopback exception), no userinfo/query/fragment, `127.0.0.1` callback on exact `/callback` path, state+issuer validation, single-workspace enforcement, generalized error output.
- **Action/workflow (besides E-003):** SHA-pinned actions; `rev-parse --verify --end-of-options` ref resolution; allowlisted scan modes/severities; `pull_request` (not `pull_request_target`) trigger; jq-escaped SARIF entries; gitleaks range bound to verified SHAs; scanner-error path fails closed.
- **`gate --verdict` response handling:** inline cast instead of schema validation — verified fail-closed (anything but literal `READY`+`applicable:true` exits 1/2); a hostile API origin could forge a schema-valid `READY` regardless, so response integrity rests on TLS+origin pinning, not on zod — no exploitable delta, hardening only.
