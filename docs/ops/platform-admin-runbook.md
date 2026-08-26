# Platform administrator operations runbook

This runbook owns platform-administrator enrollment, provisioning, access checks, browser proof, and emergency revocation. It does not prove current production account state; the provisioning workflow receipt is the source for each production run.

Current receipt: preflight `32925726620` and apply `32925979621` passed on 2026-08-26. Both named operators then completed independent Google-plus-TOTP sessions across overview, users, workspaces, scans, audit, and affiliates. Unauthenticated, bearer-only, and workspace-header-only overview requests returned `401` with private/no-store caching. Repeat this proof after any future apply.

## Fixed administrator set

Platform administration is limited to exactly these verified accounts:

- `ecryptoguru@gmail.com`
- `ankit@lyrashieldai.com`

`packages/config/src/platform-admin.ts` is the code allowlist. Production must explicitly set `PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com`; startup rejects missing or different production configuration. Workspace membership, owner roles, API keys, OAuth bearer tokens, MCP credentials, and CLI credentials never grant platform authority.

An eligible account must have all of the following:

- exactly one user record for its allowlisted email;
- verified email;
- `platformRole=PLATFORM_OPERATOR`;
- TOTP enabled with exactly one verified enrollment;
- a browser-cookie session created by successful TOTP verification.

Do not share passwords, TOTP seeds, QR codes, or recovery codes between administrators. Each administrator must create or recover their own production account and personally enroll TOTP through **Dashboard > Settings** before provisioning can pass.

## Database and deployment prerequisites

The admin schema is forward-only and additive:

1. `20260822000000_user_platform_role` adds global operator identity.
2. `20260824090000_platform_admin_totp` adds TOTP session stamps, one-time elevations, challenge limits, and audit records.

The second migration enables RLS on global admin tables and revokes `app_runtime_prod` access when that role exists. Admin security services use the separately configured system connection. Do not point `DATABASE_SYSTEM_URL` at ordinary runtime credentials, and do not give the runtime role `BYPASSRLS` or superuser authority.

The provisioning workflow checks `prisma migrate status`; it does not deploy migrations. Deploy and verify migrations before provisioning. An application-image rollback must leave these additive migrations in place.

## Production preflight

Use **Actions > Provision platform administrators** on the exact reviewed revision. The workflow uses the protected `azure-production` environment and `DATABASE_DIRECT_URL`. The environment accepts protected branches only and disables administrator bypass.

Select:

- Mode: `preflight`
- Confirmation: `preflight-exact-two-platform-admins`

Preflight is read-only. It fails closed unless:

- production migrations are current;
- both allowlisted accounts exist exactly once;
- both emails are verified;
- both accounts have TOTP enabled and exactly one verified TOTP record;
- neither account has an unsupported platform role;
- no non-allowlisted `PLATFORM_OPERATOR` exists.

Keep the workflow URL, revision, timestamp, and step summary as the receipt. A passing local test, merged revision, or successful deployment is not a production provisioning receipt.

## Production apply

Run apply only after a passing preflight for the same deployed revision and after both administrators confirm they can generate current TOTP codes.

Select:

- Mode: `apply`
- Confirmation: `apply-exact-two-platform-admins`

Apply performs one database transaction. For both exact accounts it rechecks identity and MFA state, sets `platformRole=PLATFORM_OPERATOR`, deletes all existing action elevations, deletes all sessions, and writes one `platform_admin.bootstrap` audit record. Any concurrent account change or audit failure rolls back the whole transaction.

Apply revokes sessions even when both roles were already correct. This is intentional reconciliation, not a no-op. Both administrators must sign in again and complete TOTP after every apply. Never run apply during an active admin incident response or unfinished critical mutation.

After apply, capture proof separately for each account:

1. Sign in with the account's configured identity provider. Current production operators use Google sign-in.
2. Complete the TOTP challenge; trusted-device bypass is disabled.
3. Confirm **Platform Admin** appears in dashboard navigation.
4. Open `/dashboard/admin` and each Users, Workspaces, Scans, Audit, and Affiliates destination.
5. Confirm admin API responses are private and `no-store` and that no customer payload or secret is exposed.
6. Sign out when proof is complete.

Do not automate production TOTP, store a production seed in CI, or substitute the disposable browser test for this proof.

## Non-production browser proof

Use only a disposable local PostgreSQL database. `e2e/platform-admin.spec.ts` refuses any `DATABASE_URL` whose host is not `localhost` or `127.0.0.1`.

```bash
pnpm exec playwright test e2e/platform-admin.spec.ts --project=chromium
```

The test creates a temporary non-production account, marks its email verified, enrolls and verifies real TOTP through the UI, proves deny-by-default before role grant, seeds `PLATFORM_OPERATOR`, revokes the old session, signs in through TOTP, opens all admin destinations, checks private/no-store API behavior, checks mobile overflow, and removes the temporary account. It proves browser wiring for one disposable identity; it does not provision either production account or prove live infrastructure.

## Runtime security behavior

- Admin pages return not-found when the complete browser identity check fails, reducing route disclosure.
- Global reads require a server-stamped TOTP verification no older than 12 hours.
- Critical writes require TOTP no older than 30 minutes, same-origin JSON, and an action-specific one-time nonce.
- Elevation issuance verifies TOTP again and requires the resulting stamp to be no older than 60 seconds. Issued nonces last 5 minutes by default, never more than 10 minutes, and are stored only as hashes.
- Nonce consumption, the critical database mutation, and the audit record commit atomically. Reuse, expiry, session mismatch, role loss, or audit failure denies or rolls back the mutation.
- Admin TOTP and recovery attempts are limited to 5 attempts per user and authoritative IP in 15 minutes. Better Auth also locks the account after 10 failed attempts for 15 minutes.
- Missing authoritative client IP fails closed. Configure `TRUSTED_PROXY_IP_HEADER` only when ingress strips client-supplied copies and writes the authoritative value.
- Recovery-code use stamps the exact session, writes `platform_admin.recovery_code_used`, and sends a security alert.
- Disabling MFA deletes every session and elevation for that administrator, writes `platform_admin.mfa_disabled`, and sends a security alert.

## Rollback and emergency revocation

There is no automated role rollback in the provisioning workflow. Re-running apply reconciles the same exact two administrators and revokes their sessions again; it does not demote them.

For compromised or unintended access:

1. Treat it as a security incident and preserve workflow and admin-audit receipts.
2. Revoke the affected account's `platformRole`, sessions, and elevations atomically through a reviewed system-credential change; record an incident-linked audit receipt. Do not use the tenant runtime connection or an unaudited dashboard shortcut.
3. Reset account credentials, rotate or re-enroll TOTP and recovery codes, verify email ownership, then rerun production preflight.
4. Run apply only after both exact accounts again satisfy the gate. Expect all administrator sessions to be revoked.
5. Re-run authenticated production browser proof for both accounts.

Do not reverse the migrations to revoke access. Do not delete admin audit records during rollback. If a repeatable emergency deprovision command becomes necessary, add a separately reviewed, fail-closed workflow rather than expanding the provisioning workflow ad hoc.

## Verification commands

Run focused security and provisioning checks after changing this path:

```bash
pnpm exec vitest run \
  packages/config/src/platform-admin.test.ts \
  packages/db/scripts/provision-platform-admins.test.ts \
  packages/db/src/platform-admin-security.test.ts \
  packages/db/src/migration-constraints.test.ts \
  packages/auth/src/platform-operator.test.ts \
  packages/auth/src/platform-admin-mfa-hooks.test.ts \
  apps/web/src/app/api/admin/elevations/route.test.ts
pnpm exec prettier --check docs/ops/platform-admin-runbook.md docs/README.md
```

Run the disposable Playwright proof separately because it builds and starts the web application and requires local database state.
