#!/bin/sh
set -eu

exec pnpm --filter @lyrashield/db exec tsx -e \
  '(async () => { await import("../../packages/config/src/index.ts") })()'
