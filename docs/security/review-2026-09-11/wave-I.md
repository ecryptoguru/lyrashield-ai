# Wave I — Cross-cutting: crypto, secrets, logging, randomness, errors, config

Baseline: `main` @ `3b289a43`. Threat actors: T1–T4.

- Files reviewed: ~40 — licenses, evidence-storage, logger, config, gate, score, types + cross-repo consumers (api-key-service, platform-admin-security, report-service, launch-report-*, evidence.ts, slow-query-log, license-fulfillment, launch-report-keys, razorpay/polar webhooks, auth/session/oauth, affiliate, egress-proxy, api-response, api-auth, rate-limit, HMAC-state libs, license-service, receipts, verify/health/ready/elevations/scans routes).
- Findings: 1 (Medium). Needs Verification: 5.

## Findings

### [VULN-I-001] `secureCookies` fails open on non-HTTPS `BETTER_AUTH_URL` (Severity: Medium)

- Location: `packages/auth/src/auth.ts:27` — `useSecureCookies`/session `Secure` flag derived from the `BETTER_AUTH_URL` scheme; `packages/config/src/env.ts:26` accepts any URL — no production `https:` refine (contrast: the egress-proxy rule at `env.ts:447` does enforce scheme).
- Confidence: High
- Threat actor: T1 (config-typo enabled MITM window)
- Issue: A production config typo (`BETTER_AUTH_URL=http://...`) silently ships session cookies without the `Secure` flag. Nothing in the env schema requires `https:` when `NODE_ENV=production`.
- Impact: Session cookies transmittable over plaintext → MITM session theft in the degraded-config window.
- Fix: Add a schema refine requiring `https:` for `BETTER_AUTH_URL` when `NODE_ENV=production` (or when the URL host is non-loopback).
- v16Overlap: false

## Needs Verification

1. better-auth@1.7.1 TOTP `secret`/`backupCodes` at-rest encryption — node_modules uninspectable in review env; confirm whether the plugin stores TOTP secrets encrypted at rest.
2. Logger marker gap — `api_key`/`x-api-key`/`private_key`/`jwt`/`bearer`/`passphrase`/`dsn`/`sessionid` don't match the redaction substring markers; no leak site found (latent gap, not an active leak).
3. `Error.message` strings aren't secret-scanned before reaching logs.
4. `NODE_ENV` default `development` degrades prod guards in non-Next runtimes (worker doesn't import the affected guards — confirm no other consumer).
5. `LYRASHIELD_MCP_ALLOW_*` envs declared but never consumed — dead config, confirm intended.

## Verified safe (high-confidence)

- ed25519 license + launch-report signing: canonical JSON deterministic; verify fails closed; server/bundled key only; revocation enforced; Key Vault prod path fails closed, e2e carve-out can't weaken prod.
- AES-256-GCM envelope: fresh DEK + random nonces, dual tags, missing-KEK fail-closed, versioned keyring rotation.
- All authorization-bearing tokens CSPRNG ≥128-bit (`lsk_` API keys, share tokens, elevation nonces, retrieval tokens) + SHA-256 at rest.
- Webhooks: constant-time HMAC compare.
- `Math.random` only in UI receipt IDs (non-authz) + SDK retry jitter — verified receipt IDs are session-local, not authorization-bearing.
- Logger: redaction recursive/circular-safe/truncated; `setRequestId` real-wired via AsyncLocalStorage on main (v16 feature confirmed live).
- Error responses carry no stacks/internals; health/ready expose booleans only.
- Platform-admin allowlist exact-two enforced; admin elevation nonce single-use + TTL + txn-time revalidation + rate-limited; bearer rejected at admin boundary.
