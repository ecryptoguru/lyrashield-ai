# Live-DB RLS verification — License NULL-workspaceId (B-L08)

The CI suite `packages/db/src/rls-fail-closed.test.ts` ("License
NULL-workspaceId (B-L08 + issue path)" block, and the child-table write-path
tests) is green (16/16), but it has only ever run against the ephemeral
Postgres that CI spins up. This runbook lets you replay the **same
invariants** against a real, production-shaped database after you provision
the runtime role — the check called out as "unverified" in
`docs/deployment/PRODUCTION_DEPLOYMENT.md` blocker #2.

## What it verifies

Mirrors the B-L08 assertions exactly:

1. A privileged (bypass) role can insert and read back a `NULL`-workspaceId
   `License` and its `LicenseKey` — the direct-Polar-purchase path that
   `getSystemPrisma()` serves.
2. A `NOBYPASSRLS` role with **no** workspace context sees **0** rows for that
   license and key.
3. A `NOBYPASSRLS` role with a **different** workspace context sees **0** rows.
4. A `NOBYPASSRLS` role doing a **key-hash lookup** (the exact issue-route
   query that caused the duplicate-mint bug before `getSystemPrisma()` was
   adopted) sees **0** rows.
5. Positive control: the same restricted role, given the **owning** workspace
   context, **does** see its own workspace-linked license — this distinguishes
   "correctly fails closed" from "policy always denies everything," the exact
   failure mode the CI write-path test was added to catch.

The script also refuses to run if the runtime role can bypass RLS
(`rolbypassrls` or `rolsuper`), because a superuser makes every assertion pass
vacuously.

## Prerequisites

- `psql` installed locally.
- Network access to the target Postgres.
- A **privileged** connection string able to run migrations and create roles
  (this is `DATABASE_DIRECT_URL` in production terms).
- Either:
  - permission to create a throwaway `NOBYPASSRLS` role (the script creates
    and drops it), **or**
  - an existing production runtime role's credentials (pass `--runtime-url`).
- `pnpm` + Node if you want the script to apply migrations itself; otherwise
  run against an already-migrated database with `--skip-migrate`.

## Run it

Against a fresh database (script applies migrations, creates the role, runs
assertions, cleans up):

```bash
packages/db/scripts/verify-license-rls-live.sh \
  --admin-url "postgresql://migrator:PASS@host:5432/lyrashield" \
  --runtime-role-name app_runtime_verify \
  --runtime-role-password "$(openssl rand -hex 24)"
```

Against production with the existing runtime role (recommended — this is the
actual verification that blocker #2 asks for):

```bash
packages/db/scripts/verify-license-rls-live.sh \
  --admin-url "$DATABASE_DIRECT_URL" \
  --runtime-url "$DATABASE_URL" \
  --skip-migrate
```

Every row the script creates is namespaced with a unique `rls-live-<uuid>`
prefix and deleted in a `trap` on exit, including the throwaway role if the
script created it.

## Pass/fail

- Exit `0` and `result: 6 passed, 0 failed` → the production RLS posture for
  the License NULL-workspaceId path matches CI. Record the run as evidence and
  close blocker #2 for the License surface.
- Any `FAIL` line, or the `can bypass RLS` error → **stop**. The runtime role
  is mis-provisioned or a policy drifted. Do not treat a vacuous pass as
  success.

## Note on `migrate deploy` vs `migrate dev`

The script uses `prisma migrate deploy` (via `pnpm --filter @lyrashield/db
migrate:deploy`) — never `migrate dev` — against a shared database. `deploy`
only applies committed migrations and does not prompt or generate new ones.
