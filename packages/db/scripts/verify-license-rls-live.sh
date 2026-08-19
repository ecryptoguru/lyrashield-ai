#!/usr/bin/env bash
#
# verify-license-rls-live.sh — replay the License NULL-workspaceId RLS
# assertions from packages/db/src/rls-fail-closed.test.ts ("License
# NULL-workspaceId (B-L08 + issue path)") against a REAL Postgres outside CI.
#
# CI proved these invariants green (16/16), but they have never been replayed
# against a production-shaped database. This harness is the founder/ops way to
# do that after provisioning the production NOBYPASSRLS runtime role.
#
# What it does, in order:
#   1. Applies the full production migration chain (prisma migrate deploy).
#   2. Creates a restricted NOBYPASSRLS runtime role (or reuses one you provide).
#   3. Creates two workspaces plus a NULL-workspaceId License + LicenseKey
#      (the direct-Polar-purchase path) through the PRIVILEGED role.
#   4. Asserts the read paths behave correctly:
#        a. privileged role reads the NULL-workspaceId License back
#        b. privileged role reads the LicenseKey back by keyHash
#        c. NOBYPASSRLS role with no workspace context sees 0 License rows
#        d. NOBYPASSRLS role with a different workspace context sees 0 rows
#        e. NOBYPASSRLS role key-hash lookup sees 0 LicenseKey rows
#        f. NOBYPASSRLS role WITH the owning workspace context sees its own rows
#   5. Cleans up every row it created (and the role, if it created it).
#
# Usage:
#   packages/db/scripts/verify-license-rls-live.sh \
#     --admin-url "postgresql://migrator:PASS@host:5432/lyrashield" \
#     --runtime-role-name app_runtime \
#     --runtime-role-password 'STRONG_PASSWORD'
#
# Or, if the restricted role already exists (production case):
#   packages/db/scripts/verify-license-rls-live.sh \
#     --admin-url "postgresql://migrator:PASS@host:5432/lyrashield" \
#     --runtime-url "postgresql://app_runtime:PASS@host:5432/lyrashield"
#
# Requirements: psql, and either pnpm+node (for prisma migrate deploy) or a
# pre-migrated database (pass --skip-migrate).
#
# Exit codes: 0 = all assertions passed; 1 = assertion failed; 2 = usage/setup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ADMIN_URL=""
RUNTIME_URL=""
RUNTIME_ROLE_NAME=""
RUNTIME_ROLE_PASSWORD=""
SKIP_MIGRATE=0
CREATED_ROLE=0

usage() {
  sed -n '2,40p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-url) ADMIN_URL="$2"; shift 2;;
    --runtime-url) RUNTIME_URL="$2"; shift 2;;
    --runtime-role-name) RUNTIME_ROLE_NAME="$2"; shift 2;;
    --runtime-role-password) RUNTIME_ROLE_PASSWORD="$2"; shift 2;;
    --skip-migrate) SKIP_MIGRATE=1; shift;;
    -h|--help) usage;;
    *) echo "Unknown arg: $1" >&2; usage;;
  esac
done

if [[ -z "$ADMIN_URL" ]]; then
  echo "ERROR: --admin-url (privileged, migration-capable) is required." >&2
  usage
fi

if [[ -z "$RUNTIME_URL" && ( -z "$RUNTIME_ROLE_NAME" || -z "$RUNTIME_ROLE_PASSWORD" ) ]]; then
  echo "ERROR: provide either --runtime-url, or --runtime-role-name + --runtime-role-password." >&2
  usage
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed or not on PATH." >&2
  exit 2
fi

# Derive host/db/user pieces from the admin URL for role/bootstrap SQL that
# must run as the privileged user. We pass the URL wholesale to psql.
SUFFIX="$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' || date +%s%N)"
OWNER_WS="rls-live-owner-${SUFFIX}"
OTHER_WS="rls-live-other-${SUFFIX}"
LIC_ID="rls-live-lic-${SUFFIX}"
LICKEY_ID="rls-live-lk-${SUFFIX}"
KEY_HASH="rls-live-keyhash-${SUFFIX}"
OWNER_EMAIL="rls-live-${SUFFIX}@example.com"

echo "== LyraShield License NULL-workspaceId live RLS verification =="
echo "   suffix: ${SUFFIX}"

cleanup() {
  echo "== cleanup =="
  psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -q \
    -c "DELETE FROM \"LicenseKey\" WHERE id = '${LICKEY_ID}'" \
    -c "DELETE FROM \"License\" WHERE id = '${LIC_ID}'" \
    -c "DELETE FROM \"Workspace\" WHERE id IN ('${OWNER_WS}','${OTHER_WS}')" || true
  if [[ "$CREATED_ROLE" == "1" && -n "$RUNTIME_ROLE_NAME" ]]; then
    psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -q \
      -c "REASSIGN OWNED BY ${RUNTIME_ROLE_NAME} TO CURRENT_USER" \
      -c "DROP ROLE IF EXISTS ${RUNTIME_ROLE_NAME}" || true
  fi
}
trap cleanup EXIT

# --- Step 1: migrations -------------------------------------------------------
if [[ "$SKIP_MIGRATE" == "0" ]]; then
  echo "== step 1: apply production migration chain (prisma migrate deploy) =="
  if command -v pnpm >/dev/null 2>&1; then
    ( cd "$DB_PKG_DIR" && DATABASE_URL="$ADMIN_URL" DATABASE_DIRECT_URL="$ADMIN_URL" pnpm migrate:deploy )
  else
    echo "ERROR: pnpm not found. Re-run with --skip-migrate against an already-migrated DB." >&2
    exit 2
  fi
else
  echo "== step 1: skipped (--skip-migrate) =="
fi

# --- Step 2: restricted runtime role ------------------------------------------
if [[ -z "$RUNTIME_URL" ]]; then
  echo "== step 2: create NOBYPASSRLS runtime role ${RUNTIME_ROLE_NAME} =="
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "CREATE ROLE ${RUNTIME_ROLE_NAME} LOGIN PASSWORD '${RUNTIME_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS" \
    -c "GRANT CONNECT ON DATABASE $(psql "$ADMIN_URL" -tAc 'SELECT current_database()') TO ${RUNTIME_ROLE_NAME}" \
    -c "GRANT USAGE ON SCHEMA public, app TO ${RUNTIME_ROLE_NAME}" \
    -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE_NAME}" \
    -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE_NAME}"
  CREATED_ROLE=1
  # Build a runtime URL by swapping credentials into the admin URL shape.
  RUNTIME_URL="$(echo "$ADMIN_URL" | sed -E "s#^postgresql://[^:]+:[^@]+@#postgresql://${RUNTIME_ROLE_NAME}:${RUNTIME_ROLE_PASSWORD}@#")"
else
  echo "== step 2: using provided --runtime-url =="
fi

# Guard: refuse to run assertions as a role that can bypass RLS (the test in
# CI fails outright in the same situation — vacuous passes are worse than none).
BYPASS_CHECK="$(psql "$RUNTIME_URL" -tAc "SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user")"
if [[ "$BYPASS_CHECK" == "t" ]]; then
  echo "ERROR: runtime role can bypass RLS (rolbypassrls or rolsuper is true)." >&2
  echo "       Assertions would pass vacuously. Use a NOSUPERUSER NOBYPASSRLS role." >&2
  exit 1
fi

# --- Step 3: seed workspaces + NULL-workspaceId license via privileged role ---
echo "== step 3: seed workspaces + NULL-workspaceId License/LicenseKey (privileged) =="
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"Workspace\" (id, name, slug) VALUES ('${OWNER_WS}', 'RLS live owner', '${OWNER_WS}'), ('${OTHER_WS}', 'RLS live other', '${OTHER_WS}')" \
  -c "INSERT INTO \"License\" (id, \"workspaceId\", \"ownerEmail\", sku, \"seatCount\", \"machineIds\", \"updateEligibleUntil\", \"signingKeyId\", signature, \"issuedAt\", revoked, \"createdAt\", \"updatedAt\") VALUES ('${LIC_ID}', NULL, '${OWNER_EMAIL}', 'individual_launch', 1, ARRAY[]::TEXT[], NOW() + interval '365 days', 'test', 'pending', NOW(), false, NOW(), NOW())" \
  -c "INSERT INTO \"LicenseKey\" (id, \"licenseId\", \"workspaceId\", \"keyHash\", \"issuedByProvider\", \"createdAt\") VALUES ('${LICKEY_ID}', '${LIC_ID}', NULL, '${KEY_HASH}', 'polar:rls-live-${SUFFIX}', NOW())"

PASS=0
FAIL=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: ${label} (expected ${expected}, got ${actual})"
    PASS=$((PASS+1))
  else
    echo "  FAIL: ${label} (expected ${expected}, got ${actual})" >&2
    FAIL=$((FAIL+1))
  fi
}

# --- Step 4: assertions ---------------------------------------------------------
echo "== step 4: assertions =="

# a. privileged reads NULL-workspaceId License back
PRIV_LIC="$(psql "$ADMIN_URL" -tAc "SELECT count(*) FROM \"License\" WHERE id = '${LIC_ID}'")"
assert_eq "privileged reads NULL-workspaceId License" "1" "$PRIV_LIC"

# b. privileged reads LicenseKey back by hash
PRIV_KEY="$(psql "$ADMIN_URL" -tAc "SELECT count(*) FROM \"LicenseKey\" WHERE \"keyHash\" = '${KEY_HASH}'")"
assert_eq "privileged reads LicenseKey by keyHash" "1" "$PRIV_KEY"

# c. NOBYPASSRLS, no workspace context -> 0 License rows
NOCTX_LIC="$(psql "$RUNTIME_URL" -tAc \
  "BEGIN; SELECT set_config('app.current_workspace_id','',true); SELECT count(*) FROM \"License\" WHERE id = '${LIC_ID}'; ROLLBACK;" \
  | tail -n1 | tr -d '[:space:]')"
assert_eq "NOBYPASSRLS + no context hides License" "0" "$NOCTX_LIC"

# d. NOBYPASSRLS, different workspace context -> 0 rows
OTHER_LIC="$(psql "$RUNTIME_URL" -tAc \
  "BEGIN; SELECT set_config('app.current_workspace_id','${OTHER_WS}',true); SELECT count(*) FROM \"License\" WHERE id = '${LIC_ID}'; ROLLBACK;" \
  | tail -n1 | tr -d '[:space:]')"
assert_eq "NOBYPASSRLS + other workspace hides License" "0" "$OTHER_LIC"

# e. NOBYPASSRLS key-hash lookup -> 0 LicenseKey rows (the issue-route bug)
NOCTX_KEY="$(psql "$RUNTIME_URL" -tAc \
  "BEGIN; SELECT set_config('app.current_workspace_id','',true); SELECT count(*) FROM \"LicenseKey\" WHERE \"keyHash\" = '${KEY_HASH}'; ROLLBACK;" \
  | tail -n1 | tr -d '[:space:]')"
assert_eq "NOBYPASSRLS key-hash lookup hides LicenseKey" "0" "$NOCTX_KEY"

# f. owning-workspace context still sees its own rows (positive control)
#    Re-seed a workspace-linked license for the owner workspace and confirm it
#    IS visible to the owner (guards against a policy that always denies).
OWNED_LIC_ID="rls-live-owned-${SUFFIX}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"License\" (id, \"workspaceId\", \"ownerEmail\", sku, \"seatCount\", \"machineIds\", \"updateEligibleUntil\", \"signingKeyId\", signature, \"issuedAt\", revoked, \"createdAt\", \"updatedAt\") VALUES ('${OWNED_LIC_ID}', '${OWNER_WS}', '${OWNER_EMAIL}', 'individual_launch', 1, ARRAY[]::TEXT[], NOW() + interval '365 days', 'test', 'pending', NOW(), false, NOW(), NOW())"
OWNED_VIS="$(psql "$RUNTIME_URL" -tAc \
  "BEGIN; SELECT set_config('app.current_workspace_id','${OWNER_WS}',true); SELECT count(*) FROM \"License\" WHERE id = '${OWNED_LIC_ID}'; ROLLBACK;" \
  | tail -n1 | tr -d '[:space:]')"
assert_eq "owning workspace sees its own License (positive control)" "1" "$OWNED_VIS"
psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -q -c "DELETE FROM \"License\" WHERE id = '${OWNED_LIC_ID}'" || true

echo "== result: ${PASS} passed, ${FAIL} failed =="
[[ "$FAIL" == "0" ]]
