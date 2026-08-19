## What this is

The three Sprint-10 production-readiness deliverables the founder asked for — **documentation + tooling only, no product-behavior change.** Branch + PR per the standing rule; nothing here touches `main` directly.

## Deliverables

### 1. `docs/ops/license-signing-keys-runbook.md` — signing-key + secrets provisioning

Step-by-step runbook grounded in the **actual** repo at `main @ 0d61b1a6`:
- ed25519 license-signing key generation (`openssl genpkey -algorithm ed25519`), public-key extraction, key-ID convention.
- Storing the key in **Azure Key Vault** (`lyrashieldprodsecrets`) and how the deploy reads it — mirroring the existing `secretref:*` pattern in `deploy-azure.yml` used for `LYRASHIELD_EVIDENCE_KEK` / `github-app-*`.
- The full GitHub Actions secret/variable list for Cloud billing (Polar + Razorpay), Local licensing, and affiliate payouts (RazorpayX / Payoneer), plus verification via `secrets_sync.py check-secrets`.
- Rotation/compromise → points at the existing `docs/license-key-compromise-runbook.md`.
- The Tauri-updater-key-loss warning.

**Honest gap callout (important):** as of `main @ 0d61b1a6` there is **no** `apps/desktop`, no `tauri.conf.json`, and **no `.github/workflows/release-tauri.yml`**. The "release build fails closed without `LYRASHIELD_LICENSE_PUBKEY_HEX` / `LYRASHIELD_UPDATER_PUBKEY`" behavior described in the brief does not exist yet. The runbook documents the real state (Key Vault + deploy secrets) and lists the Tauri secret set as *eventual, not yet consumed* rather than inventing CI jobs. §6 lists all current gaps including the `TODO(production)` Key Vault client in `license-service.ts` and the `TODO(email)` in the license issue route.

### 2. `packages/db/scripts/verify-license-rls-live.sh` + `docs/ops/license-rls-live-verification.md` — live-DB RLS harness

A runnable harness that replays the **License NULL-workspaceId (B-L08 + issue path)** assertions from `packages/db/src/rls-fail-closed.test.ts` against a **real** Postgres outside CI:
- Applies the production migration chain (`prisma migrate deploy`, never `migrate dev`).
- Creates a `NOBYPASSRLS` runtime role (or uses your existing one via `--runtime-url`).
- Seeds a NULL-workspaceId `License` + `LicenseKey` (the direct-Polar-purchase path) through the privileged role.
- Asserts 6 invariants: privileged read-back (×2), hidden from no-context, hidden from a different workspace, hidden from a NOBYPASSRLS key-hash lookup (the issue-route bug), plus a **positive control** (owning workspace *does* see its own row) to distinguish "fails closed" from "always denies."
- **Refuses to run as a superuser / BYPASSRLS role** — vacuous passes are worse than none.
- Cleans up every row and the throwaway role via a `trap`.

This is the concrete verification that `docs/deployment/PRODUCTION_DEPLOYMENT.md` **blocker #2** ("verify the runtime database role cannot bypass RLS") asks for.

### 3. `docs/ops/production-smoke-test-plan.md` — production smoke-test plan

Exact steps + pass/fail criteria + log/DB checks for all three flows, with a **"do NOT run in production until X"** preconditions table and a per-flow rollback/abort note:
- **Cloud:** signup → 14-day trial (no card) → metered Standard scan → 100-min cap / 14-day clock → upgrade → checkout (monthly + annual, Polar USD + Razorpay INR, incl. the ₹15,000 UPI AutoPay cap routing) → metered scan on paid + grace → minute-pack purchase → Team overage with spend limit → 14-day refund reversal. Verifies `UsageRecord` idempotency keys, the Deep Pro+ gate, the grace state machine, annual-grants-monthly (not lump-sum), and that no `$` cost fields leak to the dashboard.
- **Local:** Polar purchase → license issued → desktop online activation (Individual seat cap 3, 4th fails) → offline grace → revalidate → revoke → hard-stop, plus the detached-blob wire-format round-trip against real keys.
- **Affiliate:** apply (terms-gated) → approve → link → click (`__ls_aff` cookie, consent-gated) → referred signup → conversion → commission (25%/30% tier, 12-month cap) → reserve hold → payout eligibility → payout. Verifies the **no-commission-on-minute-packs** guard and clawback on refund.

## Explicitly NOT touched (founder-pending)

Revocation-vs-fallback policy, the annual Cloud 25%-vs-30% tier kicker, and Cashfree — all left alone by design.

## Verification

- **Sandbox limits:** no `node_modules`, npm registry is 403, no `psql`/`docker`/`cargo` locally. TypeScript-level checks are therefore **CI-verified only**.
- The harness script is `bash -n` syntax-checked and its `--help` path executes cleanly; its real run requires a live Postgres.
- Every route name, constant, env var, event type, and schema field cited in the docs was verified against the live repo at `main @ 0d61b1a6` (e.g. `GRACE_CAP_MS = 900000`, `DEEP_SCAN_MULTIPLIER = 3`, `AFFILIATE_TERMS_VERSION = "2026-08-18-v1"`, `INDIVIDUAL_MACHINE_CAP = 3`, the `encodeLicenseBlob` detached format).
- Docs + one shell script only — no package.json / lockfile changes, so no `pnpm install` regeneration is needed.

## For the founder's eyes

1. The Deliverable-1 gap callout (no Tauri workflow on main) — confirm you want the runbook to describe *actual* state rather than a planned release pipeline.
2. Whether to close the `TODO(production)` Key Vault client in `license-service.ts` now or accept the Container App `secretref` pattern short-term.
3. The `TODO(email)` on license issue (buyer key not yet emailed via Brevo).
