#!/bin/sh
set -eu

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"

export DATABASE_URL="$DATABASE_ADMIN_URL"
export DATABASE_DIRECT_URL="$DATABASE_ADMIN_URL"
cd /app
exec pnpm --filter @lyrashield/db exec prisma migrate deploy
