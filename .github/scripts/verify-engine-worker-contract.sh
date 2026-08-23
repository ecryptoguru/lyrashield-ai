#!/usr/bin/env bash
set -euo pipefail

engine_checkout="${1:?engine checkout path is required}"
app_checkout="${2:?app checkout path is required}"
pin_file="$engine_checkout/.lyrashield-worker-pin"
tests_file="$engine_checkout/scripts/worker-contract-tests.txt"

if [[ ! -f "$pin_file" || ! -f "$tests_file" ]]; then
  echo "Pinned engine is missing its worker contract declaration." >&2
  exit 2
fi

reviewed_app_sha="$(tr -d '[:space:]' < "$pin_file")"
if ! [[ "$reviewed_app_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Engine worker-consumer pin is not an immutable commit SHA." >&2
  exit 2
fi
if ! git -C "$app_checkout" merge-base --is-ancestor "$reviewed_app_sha" HEAD; then
  echo "Current app does not descend from engine-reviewed consumer $reviewed_app_sha." >&2
  exit 2
fi
if [[ -n "$(git -C "$app_checkout" status --porcelain --untracked-files=no)" ]]; then
  echo "Worker-consumer checkout has tracked modifications." >&2
  exit 2
fi

contract_tests=()
while IFS= read -r test_path; do
  [[ -z "$test_path" ]] || contract_tests+=("$test_path")
done < "$tests_file"
if [[ ${#contract_tests[@]} -eq 0 ]]; then
  echo "Pinned engine declares no worker contract tests." >&2
  exit 2
fi
for test_path in "${contract_tests[@]}"; do
  if [[ ! -f "$app_checkout/$test_path" ]]; then
    echo "Missing worker contract test: $test_path" >&2
    exit 2
  fi
done

help="$(cd "$engine_checkout" && uv run lyrashield --help)"
for flag in --non-interactive --target --scan-mode --instruction --max-budget-usd; do
  if ! grep -Fq -- "$flag" <<< "$help"; then
    echo "Pinned engine is missing worker CLI flag: $flag" >&2
    exit 1
  fi
done

(
  cd "$app_checkout"
  corepack pnpm install --frozen-lockfile
  DATABASE_URL="postgresql://lyrashield:lyrashield@127.0.0.1:5432/lyrashield?schema=public" \
    BETTER_AUTH_SECRET="dummy-ci-only-secret-not-a-real-credential-32chars" \
    BETTER_AUTH_URL="http://127.0.0.1:3100" \
    NEXT_PUBLIC_APP_URL="http://127.0.0.1:3100" \
    corepack pnpm exec vitest run "${contract_tests[@]}"
)
