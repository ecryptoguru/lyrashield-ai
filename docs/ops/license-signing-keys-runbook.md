# License Signing Keys & Secrets Provisioning Runbook

> **Purpose.** Provision the signing keys and CI/CD secrets required for the
> Sprint-10 three-track build (Cloud billing, Local BYOK licensing, Affiliate)
> so that production deploys, license issuance, and license activation work
> end-to-end. Every command and secret name below is grounded in the live
> repository at `main @ 0d61b1a6`.
>
> **Scope guard.** This runbook provisions _only_ what the current codebase
> consumes. It does not invent CI jobs or Tauri updater keys that do not yet
> exist on `main` — see §6 "Current gaps" for the honest list.

---

## 1. What the codebase actually needs

### 1a. License signing (Local/Desktop BYOK)

The web app signs offline license files with an **ed25519** private key.
Relevant code:

- `apps/web/src/lib/licenses/license-service.ts` — resolves the key.
- `packages/licenses/src/sign.ts` — `signLicense()` uses `node:crypto`
  `sign(null, canonicalJSON(payload), privateKey)`; `encodeLicenseBlob()`
  emits `<base64(canonicalJSON(payload))>.<base64(signature)>`.
- `packages/config/src/env.ts` — declares the env vars (see below).

Env vars consumed today (from `packages/config/src/env.ts` and
`.env.example`):

| Variable                      | Required in prod                                                                   | What it is                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE_SIGNING_PRIVATE_KEY` | **Yes, but read from Azure Key Vault at runtime — the `env` fallback is dev-only** | ed25519 PKCS#8 PEM private key. Must start with `-----BEGIN`.                                                                 |
| `LICENSE_SIGNING_KEY_ID`      | **Yes** (throws in production if unset)                                            | Identifier for rotation / revocation lists, e.g. `license-key-v1`.                                                            |
| `LICENSE_SIGNING_PUBLIC_KEY`  | Optional                                                                           | SPKI PEM public key. If unset, derived from the private key at runtime.                                                       |
| `LICENSE_PUBLISHED_BUILD`     | Yes for Local                                                                      | Latest published Local/Desktop semver; used as `perpetualFallbackBuild` at issue/renew. Never accept a client-supplied value. |
| `POLAR_LOCAL_PRODUCT_IDS`     | Yes for Local checkout                                                             | JSON map of Local SKU → Polar product ID, e.g. `{"individual_launch":"prod_abc",...}`.                                        |
| `LYRASHIELD_INTERNAL_API_KEY` | Yes in prod                                                                        | Internal API key for server-to-server license issue/renew routes. Sent as `X-LyraShield-Internal-Key`.                        |

> **Fail-closed note.** `resolveSigningKeyId()` in
> `apps/web/src/lib/licenses/license-service.ts` throws
> `LICENSE_SIGNING_KEY_ID is required in production` when `NODE_ENV=production`
> and the var is unset. The private key is likewise required — the app refuses
> to sign rather than issuing an unsigned license.

### 1b. Tauri desktop updater — **NOT YET ON MAIN**

As of `main @ 0d61b1a6` there is **no** `apps/desktop` directory, no
`tauri.conf.json`, and no `.github/workflows/release-tauri.yml`. The codebase
has no Tauri updater signing key wiring to provision against. When the
desktop release pipeline is built, the secrets it will need are the standard
Tauri v2 set:

- `TAURI_SIGNING_PRIVATE_KEY` (content of the `*.key` file from
  `npx tauri signer generate`)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Apple Developer ID + App Store Connect credentials + notarytool profile
  for macOS signing/notarization

Those are listed here so the provisioning owner knows the full eventual set,
but **no secret named `TAURI_*` or `LYRASHIELD_UPDATER_PUBKEY` is consumed by
any workflow or code on `main` today.** Do not create them expecting the
current CI to use them.

### 1c. Billing providers (Cloud)

Consumed by `packages/billing` and `apps/web/src/app/api/billing/*`:

| Variable                     | Provider | Notes                               |
| ---------------------------- | -------- | ----------------------------------- |
| `POLAR_ACCESS_TOKEN`         | Polar    | Merchant-of-record API token.       |
| `POLAR_ORG_ID`               | Polar    | Organization ID.                    |
| `POLAR_WEBHOOK_SECRET`       | Polar    | Standard-Webhooks HMAC secret.      |
| `POLAR_WEBHOOK_TOLERANCE_MS` | Polar    | Optional, default `300000` (5 min). |
| `RAZORPAY_KEY_ID`            | Razorpay | India INR gateway.                  |
| `RAZORPAY_KEY_SECRET`        | Razorpay | Also fallback webhook secret.       |
| `RAZORPAY_WEBHOOK_SECRET`    | Razorpay | Dedicated webhook secret preferred. |
| `BILLING_USD_INR_RATE`       | —        | Default `100`, bounded `[50, 150]`. |
| `BILLING_GEO_IP_HEADER`      | —        | GeoIP header for provider routing.  |

### 1d. Affiliate payout providers (Track C)

| Variable                                                                  | Provider                  |
| ------------------------------------------------------------------------- | ------------------------- |
| `RAZORPAYX_API_KEY` / `RAZORPAYX_API_SECRET` / `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX (India payouts) |
| `PAYONEER_API_KEY` / `PAYONEER_API_SECRET` / `PAYONEER_PARTNER_ID`        | Payoneer (global payouts) |

### 1e. Deploy-time secrets already in use (`deploy-azure.yml`)

These are **already provisioned and consumed** by the existing Azure deploy —
listed here so the same pattern is followed for new secrets:

- `AZURE_CREDENTIALS` (GitHub secret; service principal for `azure/login`).
- `DATABASE_DIRECT_URL` (used only for `prisma migrate deploy` at deploy time).
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — synced to Container
  Apps as `upstash-redis-rest-url` / `upstash-redis-rest-token` via
  `az containerapp secret set`, then injected as `secretref:*`.
- `LYRASHIELD_EVIDENCE_KEK` — synced as `lyrashield-evidence-kek`; the worker
  VM additionally fetches it from Key Vault (`worker-evidence-kek`) via
  `ops/worker/refresh-secrets.sh`.
- `LYRASHIELD_GITHUB_APP_*` (ID, slug, private key, webhook secret, OAuth
  client ID/secret) — synced as `github-app-*` and injected as `secretref:*`.

Variables (non-secret) in `deploy-azure.yml`: `AZURE_RESOURCE_GROUP`,
`AZURE_APP_CONTAINER_APP_NAME`, `AZURE_SCANNER_CONTAINER_APP_NAME`,
`LYRASHIELD_APP_URL`, `LYRASHIELD_MARKETING_URL`,
`LYRASHIELD_SCANNER_URL`, `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION`.

---

## 2. Generate the ed25519 license signing key pair

Run this on a trusted, offline-capable machine (founder's workstation or a
dedicated ops host), **not** in CI.

```bash
# Generate the ed25519 PKCS#8 PEM private key
openssl genpkey -algorithm ed25519 -out license-signing-private.pem

# Extract the SPKI PEM public key
openssl pkey -in license-signing-private.pem -pubout -out license-signing-public.pem

# Record a key ID for rotation/revocation scoping
echo "license-key-v1" > license-signing-key-id.txt
```

Verify the private key file starts with `-----BEGIN PRIVATE KEY-----` (PKCS#8)
and the public key with `-----BEGIN PUBLIC KEY-----` (SPKI). The env schema
(`packages/config/src/env.ts`) refines `LICENSE_SIGNING_PRIVATE_KEY` with
`.refine(val => !val || val.includes("-----BEGIN"))`, so a malformed value
fails at boot.

**Permissions:** `chmod 600 license-signing-private.pem`.

---

## 3. Store the private key in Azure Key Vault

The production intent (documented in `license-service.ts` and
`packages/config/src/env.ts`) is that the app reads the signing key from
**Azure Key Vault at runtime**, not from an environment variable. The Key
Vault client wiring is currently a `TODO(production)` in
`apps/web/src/lib/licenses/license-service.ts` — the code falls back to
`LICENSE_SIGNING_PRIVATE_KEY` env today. Provisioning therefore has two
halves: put the key in Key Vault now, and track the code change that makes
the app actually read it.

### 3a. Create / identify the Key Vault

The worker VM already uses a Key Vault named by default
`lyrashieldprodsecrets` (`ops/worker/refresh-secrets.sh`,
`LYRASHIELD_KEY_VAULT_NAME`). Reuse that vault unless the founder directs
otherwise.

```bash
az keyvault show --name lyrashieldprodsecrets --resource-group <rg>
```

### 3b. Import the private key as a secret

```bash
az keyvault secret set \
  --vault-name lyrashieldprodsecrets \
  --name license-signing-private-key \
  --file license-signing-private.pem \
  --content-type "application/x-pem-file"

az keyvault secret set \
  --vault-name lyrashieldprodsecrets \
  --name license-signing-public-key \
  --file license-signing-public.pem \
  --content-type "application/x-pem-file"

az keyvault secret set \
  --vault-name lyrashieldprodsecrets \
  --name license-signing-key-id \
  --value "license-key-v1"
```

### 3c. How the deploy reads it today

Until the Key Vault client TODO is closed, the app reads
`LICENSE_SIGNING_PRIVATE_KEY` from the Container App environment. Mirror the
existing `secretref` pattern used for `LYRASHIELD_EVIDENCE_KEK`:

1. Add a GitHub Actions secret `LICENSE_SIGNING_PRIVATE_KEY` (paste the PEM,
   including `-----BEGIN/END-----` lines) and `LICENSE_SIGNING_KEY_ID`.
2. In `deploy-azure.yml`, add an `az containerapp secret set` step that writes
   `license-signing-private-key` and `license-signing-key-id` to the app
   Container App, then inject them as
   `LICENSE_SIGNING_PRIVATE_KEY=secretref:license-signing-private-key` and
   `LICENSE_SIGNING_KEY_ID=secretref:license-signing-key-id`.
3. Set `LICENSE_PUBLISHED_BUILD` as a plain env var (it is not secret).
4. Set `POLAR_LOCAL_PRODUCT_IDS` as a secret or variable (it is not secret
   but is environment-specific).

> **Security note.** Keeping the private key in a Container App secret is
> acceptable short-term but is **not** the documented end state. The founder
> should treat "wire the Key Vault client in `license-service.ts`" as a
> tracked follow-up; this runbook does not close that gap.

---

## 4. GitHub Actions CI secrets to wire

Open **Settings → Secrets and variables → Actions** on
`ecryptoguru/lyrashield-ai`.

### 4a. Secrets (new, for Sprint-10)

| Secret name                                                               | Source                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `LICENSE_SIGNING_PRIVATE_KEY`                                             | Contents of `license-signing-private.pem`                                                                                                  |
| `LICENSE_SIGNING_KEY_ID`                                                  | `license-key-v1`                                                                                                                           |
| `POLAR_ACCESS_TOKEN`                                                      | Polar dashboard                                                                                                                            |
| `POLAR_ORG_ID`                                                            | Polar dashboard                                                                                                                            |
| `POLAR_WEBHOOK_SECRET`                                                    | Polar webhook settings                                                                                                                     |
| `RAZORPAY_KEY_ID`                                                         | Razorpay dashboard                                                                                                                         |
| `RAZORPAY_KEY_SECRET`                                                     | Razorpay dashboard                                                                                                                         |
| `RAZORPAY_WEBHOOK_SECRET`                                                 | Razorpay webhook settings                                                                                                                  |
| `LYRASHIELD_INTERNAL_API_KEY`                                             | `openssl rand -hex 32`                                                                                                                     |
| `POLAR_LOCAL_PRODUCT_IDS`                                                 | JSON map of SKU → Polar product ID                                                                                                         |
| `RAZORPAYX_API_KEY` / `RAZORPAYX_API_SECRET` / `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX (affiliate payouts)                                                                                                              |
| `PAYONEER_API_KEY` / `PAYONEER_API_SECRET` / `PAYONEER_PARTNER_ID`        | Payoneer (affiliate payouts)                                                                                                               |
| `BREVO_API_KEY`                                                           | Brevo (already verified locally; still needed on the production Container App — see `docs/deployment/PRODUCTION_DEPLOYMENT.md` blocker #1) |

You can verify which secrets exist without printing values using the repo's
`secrets_sync.py` helper (see `lyrashield-github-ops` skill):

```bash
python3 secrets_sync.py --repo ecryptoguru/lyrashield-ai \
  check-secrets LICENSE_SIGNING_PRIVATE_KEY LICENSE_SIGNING_KEY_ID \
  POLAR_ACCESS_TOKEN RAZORPAY_KEY_ID LYRASHIELD_INTERNAL_API_KEY
```

### 4b. Variables (non-secret)

| Variable                  | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| `LICENSE_PUBLISHED_BUILD` | e.g. `0.1.0` — bump on each Local/Desktop release     |
| `BILLING_USD_INR_RATE`    | `100` (default; only override on founder instruction) |

### 4c. E2E signing key in CI

`playwright.config.ts` generates a throwaway ed25519 key at E2E runtime
(`/tmp/lyrashield-e2e-lic.pem`) — CI does **not** need a real license signing
secret for the E2E suite. Do not paste the production key into CI for E2E.

---

## 5. Rotation & compromise

Follow the existing **`docs/license-key-compromise-runbook.md`** (FF4) for the
full incident flow: generate a new keypair in Key Vault, ship a desktop update
that trusts the new key plus a bundled revocation list, dual-sign during a
30-day overlap window, notify affected customers via Brevo, then post-incident
review. Increment `LICENSE_SIGNING_KEY_ID` (e.g. `license-key-v2`) and update
the Key Vault secret and GitHub secret in the same change window.

> **Warning — updater key loss.** When the Tauri desktop release pipeline is
> built, its updater private key (`TAURI_SIGNING_PRIVATE_KEY`) is a
> **single point of permanent failure**: losing it means you can no longer
> push updates to existing installs. Back it up in at least two independent
> secure locations (e.g. Key Vault + an offline hardware token) at generation
> time. This does not apply to the license signing key, which is recoverable
> via the compromise runbook.

---

## 6. Current gaps (do not paper over)

1. **No Key Vault client in app code.** `license-service.ts` still resolves
   `LICENSE_SIGNING_PRIVATE_KEY` from env; production Key Vault read is a
   `TODO(production)`. Provisioning the vault secret now is correct; the code
   change to consume it is outstanding.
2. **No Tauri release workflow.** No `release-tauri.yml`, no `apps/desktop`,
   no `tauri.conf.json`. The "release build fails closed without
   `LYRASHIELD_LICENSE_PUBKEY_HEX` / `LYRASHIELD_UPDATER_PUBKEY`" behavior
   does not exist yet — do not create those secrets expecting CI to consume
   them.
3. **License issue email.** `apps/web/src/app/api/licenses/issue/route.ts`
   has a `TODO(email)` — the license key is not yet emailed to the buyer via
   Brevo on issue. Provisioning `BREVO_API_KEY` unblocks the surrounding
   infra but the call site is still TODO.
4. **Founder-pending items (untouched by design):** revocation-vs-fallback
   policy, annual Cloud 25%-vs-30% tier kicker, and the Cashfree payout
   question are explicitly out of scope here.
