# Launch Readiness Report Signing Key — Provisioning Runbook (WP4)

> **Purpose.** Provision the ed25519 signing key that signs shareable Launch
> Readiness Reports (WP4), so a third party can verify a presented report was
> issued by LyraShield and not edited after issue. Grounded in the codebase on
> `main` after PR #558 (WP4) merges.
>
> **Scope guard.** This provisions only what the code consumes. Until the key
> exists, reports issue **unsigned** (checksum present, no signature) and
> `POST /api/reports/verify` returns `NOT_CONFIGURED` — by design, never a
> guess. This runbook is the step that turns signing on.

---

## 1. What the code consumes

| Variable / secret                               | Where             | What                                                                                    |
| ----------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `LAUNCH_REPORT_SIGNING_PRIVATE_KEY`             | env (dev/CI only) | ed25519 PKCS#8 PEM private key. Must start with `-----BEGIN`.                           |
| `LAUNCH_REPORT_SIGNING_PUBLIC_KEY`              | env (optional)    | SPKI PEM public key. If unset, derived from the private key.                            |
| `LAUNCH_REPORT_SIGNING_PRIVATE_KEY_SECRET_NAME` | env               | Key Vault secret name for the private key. Default `launch-report-signing-private-key`. |
| `LAUNCH_REPORT_SIGNING_PUBLIC_KEY_SECRET_NAME`  | env               | Key Vault secret name for the public key. Default `launch-report-signing-public-key`.   |
| `LYRASHIELD_KEY_VAULT_NAME`                     | env (prod)        | The existing Key Vault name (already used for license signing).                         |

Relevant code:

- `packages/billing/src/launch-report-keys.ts` — `resolveLaunchReportSigningPrivateKey()` / `resolveLaunchReportSigningPublicKey()`. Production (NODE_ENV=production AND `LYRASHIELD_KEY_VAULT_NAME` set) reads from Key Vault; otherwise the env var.
- `packages/db/src/launch-report-signing.ts` — `signLaunchReportChecksum()` / `verifyLaunchReportSignature()` (ed25519 via node:crypto).
- `apps/web/src/app/api/reports/launch-readiness/route.ts` — signs at generation when a key resolves.
- `apps/web/src/app/api/reports/verify/route.ts` — verifies with the server's OWN public key (never a client-supplied one).

---

## 2. Generate the keypair (once, locally)

```bash
openssl genpkey -algorithm ed25519 -out launch_report_private.pem
openssl pkey -in launch_report_private.pem -pubout -out launch_report_public.pem
```

## 3. Store in Azure Key Vault (production)

```bash
az keyvault secret set \
  --vault-name "$LYRASHIELD_KEY_VAULT_NAME" \
  --name launch-report-signing-private-key \
  --file launch_report_private.pem

az keyvault secret set \
  --vault-name "$LYRASHIELD_KEY_VAULT_NAME" \
  --name launch-report-signing-public-key \
  --file launch_report_public.pem
```

The web app's managed identity needs **Get** on these two secrets (same access
policy / RBAC as the license-signing secrets).

## 4. Dev / CI

Set `LAUNCH_REPORT_SIGNING_PRIVATE_KEY` to the PEM content in the dev/CI env.
Leave the public key unset (it is derived). No Key Vault call is made outside
production.

## 5. Verify it is live

1. Generate a launch readiness report on a canary workspace with a completed
   gate verdict (`POST /api/reports/launch-readiness` with `share: true`).
2. Confirm the returned report has `signed: true` and the payload carries a
   `signature`.
3. POST the report's `reportChecksum` + `signature` to `/api/reports/verify`
   and confirm `{ verified: true }`.
4. Flip one character in the checksum and confirm `{ verified: false }` — the
   tamper check works.

## 6. Rotation

The document format carries `signingKeyId` (`lyrashield-launch-report-ed25519-1`).
Rotate by generating a new pair, storing under the same Key Vault secret names,
and bumping the key id constant in `packages/db/src/launch-report-signing.ts` so
old signatures stay verifiable against the prior published public key during the
overlap. A per-report keypair + transparency log is a possible later upgrade and
does not change the document format.
