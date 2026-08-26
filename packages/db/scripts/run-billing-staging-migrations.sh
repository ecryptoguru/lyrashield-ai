#!/bin/sh
set -eu

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"

export DATABASE_URL="$DATABASE_ADMIN_URL"
export DATABASE_DIRECT_URL="$DATABASE_ADMIN_URL"
cd /app

# Container Apps can flush stdout before stderr when a short-lived job exits.
# Keep Prisma diagnostics on one stream and print migration status before the
# job is removed so a failed migration remains recoverable by an operator.
set +e
pnpm --filter @lyrashield/db exec prisma migrate deploy 2>&1
migration_status=$?
set -e

if [ "$migration_status" -ne 0 ]; then
  echo "billing_staging_migration_failed exit_code=${migration_status}" >&2
  pnpm --filter @lyrashield/db exec prisma migrate status 2>&1 || true
  exit "$migration_status"
fi
