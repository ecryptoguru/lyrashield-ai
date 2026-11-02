#!/usr/bin/env bash
set -euo pipefail

# This qualifies the current product reader; it never replaces the engine's
# exact-revision verify-worker-contract.sh gate or changes either release pin.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tests_file="$repo_root/scripts/current-worker-contract-tests.txt"
writer_fixtures="${1:-}"

# Fail closed before executing the candidate CLI or any dependency/test command.
checked_out_sha="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null)" || {
  echo "Current worker consumer HEAD unavailable." >&2
  exit 2
}
dirty_output="$(git -C "$repo_root" status --porcelain --untracked-files=no 2>/dev/null)" || {
  echo "Current worker consumer git status failed; cannot verify cleanliness." >&2
  exit 2
}
if [[ -n "$dirty_output" ]]; then
  echo "Current worker consumer has local modifications; contract requires a clean checkout." >&2
  exit 2
fi

if [[ -z "${LYRASHIELD_BIN:-}" || ! -x "$LYRASHIELD_BIN" ]]; then
  echo "Set LYRASHIELD_BIN to the candidate engine's executable CLI." >&2
  exit 2
fi
if [[ -z "$writer_fixtures" || ! -f "$writer_fixtures/summary.json" ]]; then
  echo "Pass the generated writer fixture directory containing summary.json." >&2
  exit 2
fi
writer_fixtures="$(cd "$writer_fixtures" && pwd)"

contract_tests=()
while IFS= read -r test_path; do
  [[ -z "$test_path" || "$test_path" == \#* ]] && continue
  if [[ ! -f "$repo_root/$test_path" ]]; then
    echo "Missing current worker contract test: $test_path" >&2
    exit 2
  fi
  contract_tests+=("$test_path")
done < "$tests_file"
if [[ ${#contract_tests[@]} -eq 0 ]]; then
  echo "No current worker contract tests declared." >&2
  exit 2
fi

help="$("$LYRASHIELD_BIN" --help)"
for flag in --non-interactive --target --scan-mode --instruction --max-budget-usd --runtime-budget-seconds; do
  if ! grep -Eq -- "(^|[^[:alnum:]_-])${flag}([^[:alnum:]_-]|$)" <<< "$help"; then
    echo "Missing CLI flag required by the worker: $flag" >&2
    exit 1
  fi
done

cd "$repo_root"
echo "Current consumer HEAD: $checked_out_sha"
corepack pnpm install --frozen-lockfile
# Synthetic CI-only values match the engine's pinned worker contract. These
# suites use mocks; this command does not connect to a database or provider.
export DATABASE_URL="postgresql://lyrashield:lyrashield@127.0.0.1:5432/lyrashield?schema=public"
export BETTER_AUTH_SECRET="dummy-ci-only-secret-not-a-real-credential-32chars"
export BETTER_AUTH_URL="http://127.0.0.1:3100"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3100"
export LYRASHIELD_TEST_DB_DISPOSABLE=0
export LYRASHIELD_COMPOSER_SMOKE=0
corepack pnpm exec vitest run --coverage "${contract_tests[@]}"
corepack pnpm --filter @lyrashield/worker exec tsx ../../scripts/verify-worker-writer-artifacts.ts "$writer_fixtures"
