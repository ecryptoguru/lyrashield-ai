# Wave F — Desktop app (Tauri v2 + Rust + React/Vite) security review

Baseline: `main` @ `3b289a43`. Threat actors: T1 (local attacker/malicious license file),
T2 (attacker controlling a synced server response or scan target), T4 (compromised update channel).

- Files reviewed: 28 — all 18 src-tauri/src/**/*.rs (incl. sql/001_init.sql), tauri.conf.json,
  tauri.release.conf.json, capabilities/default.json, Cargo.toml, build.rs, Cargo.lock triage,
  bundled pubkey PEM, frontend lib/tauri.ts + types.ts + all screens/App.tsx.
  gen/schemas/ is generated at build (not committed).
- Findings: 4 (all Medium). No Critical/High.

### [VULN-F-001] Unsigned `last_server_verified_at` enables perpetual offline grace — license revocation bypass (Severity: Medium)

- Location: src/license/types.rs (StoredLicense field), src/license/store.rs (license.json write), src/license/mod.rs:405-426 (offline_grace_remaining_seconds)
- Confidence: High
- Threat actor: T1
- Issue: The 7-day offline grace anchors solely on `last_server_verified_at`, plaintext in the user-writable `~/Library/Application Support/LyraShield/license.json`. The ed25519 signature covers only the 5 payload fields — never this timestamp. Only future timestamps (>now+5min) are rejected; a "now" value is always accepted.
- Impact: A revoked/refunded license holder blocks app.lyrashieldai.com (verify → Offline) and periodically rewrites the timestamp — trivially scriptable — keeping the license operational forever. `ensure_license_operational` then passes, so start_scan / connect_workspace / sync_findings / install_update all proceed. Server revocation never lands.
- Evidence: license/mod.rs:369-399 (Offline → grace from stored ts); api.rs:29-35 (403/404/429/5xx → Offline); store.rs:19-58 (unsigned JSON, 0600 but user-owned).
- Fix: Integrity-protect the grace anchor — server-signed revalidation receipt inside the signed blob, or HMAC StoredLicense with a keychain-held key; alternatively cap total accumulated offline time.
- v16Overlap: false

### [VULN-F-002] Engine stdout/stderr ingested with no line-length/rate/total cap — memory + disk exhaustion via hostile scan output (Severity: Medium)

- Location: src/scan/runner.rs:437-504 (lines.next_line + per-line append_event + emit), src/scan/store.rs append_event
- Confidence: High
- Threat actor: T2 (malicious scan target can drive unbounded engine output — LLM-agent engine reads attacker-controlled files; prompt-injection/content echo produces arbitrary output)
- Issue: `BufReader::lines()` buffers each newline-delimited line unbounded (one giant no-newline line → one giant String); every line is redact-scanned, serialized, INSERTed into `scan_events`, and emitted over IPC. No cap on line length, event count, or per-scan DB growth.
- Impact: OOM crash on a huge single line; disk fill via millions of event rows; IPC flood — all during a legitimately initiated scan. Frontend self-caps (last 200 lines); backend is unbounded.
- Evidence: runner.rs:442 `while let Ok(Some(line)) = lines.next_line().await`; per-line persist+emit :451-456, :493-501.
- Fix: Truncate lines (e.g. >64 KiB) or byte-budgeted reads; cap/batch persisted progress events; bound total stream bytes then kill child.
- v16Overlap: false

### [VULN-F-003] ApiClient reads unbounded response bodies; error paths echo body to UI (Severity: Medium)

- Location: src/api.rs post/get/put/activate/verify (`resp.text().await`, no cap); src/sync/mod.rs:489 (`sync failed ({}): {}` embeds resp.body)
- Confidence: High
- Threat actor: T2 (release pins https://app.lyrashieldai.com — requires server compromise, in scope)
- Issue: `resp.text()` buffers the whole body; the 30 s timeout bounds duration not size — a fast hostile server streams GBs within the window. Non-2xx sync bodies are copied into `SyncResult::Error.message` shown in React (escaped, but a second full in-memory copy).
- Impact: Memory exhaustion/app crash on a single malicious response across activate/verify/sync paths. Availability only.
- Fix: Hard byte cap (content_length check + bounded chunked read ~1-5 MiB — envelopes are small); never embed raw body in error strings.
- v16Overlap: false

### [VULN-F-004] `mask_key` byte-slices UTF-8 — panics on multibyte API keys (Severity: Medium)

- Location: src/byok/mod.rs:75-82 mask_key; reachable via get_byok_metadata/get_byok_status commands
- Confidence: High
- Threat actor: T1 / self-inflicted (key containing CJK/emoji/accents)
- Issue: `&key[..4]`/`&key[len-4..]` panic when index 4 or len-4 is mid-char. Validation only requires `trim().len() >= 8` — no ASCII check — and stores the untrimmed key, so a multibyte key is saved to keychain then panics on every status read.
- Impact: Persistent IPC failure/possible process crash each time Setup polls BYOK status; recoverable only via clear_azure_config.
- Fix: Require `api_key.is_ascii()` in validate_azure_credentials; make mask_key boundary-safe (chars().take(4) etc.).
- v16Overlap: false

## Needs Verification
- Release signing/notarization: base conf has signingIdentity/certificateThumbprint null; release conf adds hardenedRuntime only. Confirm CI injects signing identity. (Updater signature is client-enforced regardless.)
- Release conf merge: tauri.release.conf.json lacks plugins.updater — confirm `--config` merge keeps pinned pubkey/endpoints in release artifacts.
- cargo audit: could not execute here. Cargo.lock matches the allowed-warning set only: chacha20 0.10.1 (yanked), glib/gio/glib-sys via webkit2gtk/wry/tao/soup3 (RUSTSEC-2024-0429, Linux only), proc-macro-error(-attr), unic-char-property/unic-common. VariantStrIter has zero occurrences in app code — unsoundness reachable only via upstream wry/webkit internals on Linux. Live `cargo audit` still required to certify nothing else. (Note: parent review ran cargo audit — 8 allowed warnings, matching this set.)
- api.rs 403/404-as-offline: verified /api/licenses/verify returns 200+revoked:true for revoked/unknown — 403/404 arise only from edge layers (WAF/route removal), bounded by grace expiry. Confirm the trade-off is deliberate.

## Verified safe (high-confidence)
- License verify: bundled prod key only (distinct from committed test vector); no dev/lenient bypass; strict field validation pre-signature; canonical-JSON golden parity; re-serialization sound because serde parsing is strict.
- Fail-closed ops: signature + machine binding before spawn/install; revoked/invalid → license cleared; legacy license migrates to forced re-activation; perpetual-fallback correctly separates operation from update eligibility.
- Storage: atomic tmp+rename, 0600 on Unix; license key/sync key/Azure creds in OS keychain only; only masked metadata crosses IPC; zero secret logging; engine output redacted before parse/persist/emit.
- machine_id: SHA-256 pseudonymous, keychain-pinned, no PII/raw serials off-box.
- Spawn: no shell; argv vectors; env_clear + strict env allowlist + BYOK creds only in child env; release engine path = bundled sidecar only (env/PATH fallbacks debug-gated).
- Scan IPC: license guard precedes spawn; budget bounded 0.01–100 finite; mode allowlisted; all SQL parameterized; migration ledger SHA-384-verified, fails on dirty/unknown.
- Sync: opt-in; Bearer header not URL; base URL pinned in release (loopback-only custom URLs in debug); session token memory-only, workspace-bound, never over IPC; seq CAS; 500/batch cap; verified:false forced.
- Updater: pinned minisign pubkey + single HTTPS GitHub endpoint; no unsigned/HTTP fallback; license-gated check+install; expected_version equality; is_build_installable gate.
- Webview: CSP script-src 'self', no eval/inline; capabilities = core:default + shell:allow-open + os:default (no fs/http/sql/updater/store); bundled frontendDist; lib.rs test asserts sql/updater perms never enter capabilities.
- Frontend: no web storage, no window globals for secrets, no dangerouslySetInnerHTML; typed invoke wrappers; keys cleared from state after save; engine-controlled text all React-escaped.
- No `unsafe` blocks anywhere in the crate.

## Hygiene notes (below finding threshold)
- shell:allow-open unscoped (only used with hardcoded https URL today) — consider scoping to https:.
- tauri-plugin-store registered but unpermissioned/unused — dead surface.
- `pub mod golden_vectors` not cfg(test)-gated — test vector + pubkey compiled into release (dead code, no trust-path impact).
- App.tsx `lastFindings` is useState([]) with no setter — syncFindings always sends empty; Cloud Sync is a functional no-op (fail-safe) until wired.
- Sync DB at data_dir()/LyraShield/lyrashield.db vs scan DB at app_config_dir()/lyrashield.db; ensure_sync_table re-creates full schema in the sync DB — consistency issue.
- `engine auth login` error text returned unredacted to webview (same trust domain); redact_credentials is best-effort patterns, not a guarantee.
