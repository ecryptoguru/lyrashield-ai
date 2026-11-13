#!/usr/bin/env bash
set -euo pipefail

# Tests for .github/scripts/azure_secret_set.sh.
#
# The helper wraps `az containerapp secret set` in a bounded retry because a
# transient Azure blip aborted a whole production rollout on 2026-09-25 (run
# 36061999137). These tests pin both halves of the contract: retryable
# signatures are retried and non-retryable ones fail fast, the retry is bounded,
# and the swallowed diagnostic is surfaced.

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
helper="$repo_root/.github/scripts/azure_secret_set.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
calls="$tmp/calls.txt"
sleeps="$tmp/sleeps.txt"
: > "$calls"
: > "$sleeps"

# A fake `az` driven by a scenario file: each invocation pops the next scripted
# response. Scenario lines are "<exit-code>|<stdout+stderr text>".
cat > "$tmp/bin/az" <<'FAKE'
#!/usr/bin/env bash
scenario="${FAKE_SCENARIO:?}"
calls="${FAKE_CALLS:?}"
printf 'call\n' >> "$calls"
printf '%s\n' "$@" >> "${FAKE_ARGS:?}"
if [[ "$*" == *"keyvault secret set"* ]]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--file" ]; then
      printf '%s\n' "$2" >> "${FAKE_FILE_PATHS:?}"
      cat "$2" >> "${FAKE_FILE_CONTENTS:?}"
      printf '\n' >> "${FAKE_FILE_CONTENTS:?}"
      break
    fi
    shift
  done
fi
line=$(sed -n "$(wc -l < "$calls")p" "$scenario")
code="${line%%|*}"
text="${line#*|}"
[ -n "$text" ] && printf '%s\n' "$text"
exit "${code:-0}"
FAKE
chmod +x "$tmp/bin/az"
# GNU timeout is absent on macOS; provide a pass-through there. Linux retains
# the real timeout implementation while fake sleep keeps backoff assertions fast.
if ! command -v timeout >/dev/null 2>&1; then
  cat > "$tmp/bin/timeout" <<'FAKE_TIMEOUT'
#!/usr/bin/env bash
[[ "${1:-}" == "--foreground" ]] && shift
shift
exec "$@"
FAKE_TIMEOUT
  chmod +x "$tmp/bin/timeout"
fi
cat > "$tmp/bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${FAKE_SLEEPS:?}"
FAKE_SLEEP
chmod +x "$tmp/bin/sleep"
export PATH="$tmp/bin:$PATH"
export FAKE_CALLS="$calls"
export FAKE_ARGS="$tmp/args.txt"
export FAKE_FILE_CONTENTS="$tmp/file-contents.txt"
export FAKE_FILE_PATHS="$tmp/file-paths.txt"
export FAKE_SLEEPS="$sleeps"

scenario() {
  printf '%s\n' "$@" > "$tmp/scenario"
  export FAKE_SCENARIO="$tmp/scenario"
  : > "$calls"
  : > "$FAKE_ARGS"
  : > "$FAKE_FILE_CONTENTS"
  : > "$FAKE_FILE_PATHS"
}
call_count() { wc -l < "$calls" | tr -d ' '; }

# The real environment sets -e; the helper must not leak that into retry logic.
set +e
# shellcheck source=/dev/null
source "$helper"
set -e

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Success on the first attempt — one call, no noise.
scenario "0|"
if ! azure_containerapp_secret_set_retrying --name app --resource-group rg --secrets "k=v" >"$tmp/out" 2>"$tmp/err"; then
  fail "expected success on first attempt"
fi
[ "$(call_count)" = "1" ] || fail "expected exactly 1 call on success, got $(call_count)"

# 2. Transient failure then success — retried, and still returns 0.
scenario "1|ERROR: ContainerAppOperationInProgress" "0|"
if ! out=$(azure_containerapp_secret_set_retrying --name app --resource-group rg --secrets "k=v" 2>"$tmp/err"); then
  fail "expected success after one transient retry"
fi
[ "$(call_count)" = "2" ] || fail "expected 2 calls (retry), got $(call_count)"
grep -Fq "retrying" "$tmp/err" || fail "expected a retry warning on stderr"

# 3. Timeout (exit 124) is treated as transient even though it prints nothing.
scenario "124|" "0|"
if ! azure_containerapp_secret_set_retrying --name app --resource-group rg --secrets "k=v" >/dev/null 2>&1; then
  fail "expected a timeout to be retried"
fi
[ "$(call_count)" = "2" ] || fail "expected 2 calls after a timeout, got $(call_count)"

# 4. Non-retryable failure fails fast (no retry) and surfaces the diagnostic.
scenario "1|ERROR: The client 'x' does not have authorization to perform action"
if azure_containerapp_secret_set_retrying --name app --resource-group rg --secrets "k=v" >/dev/null 2>"$tmp/err"; then
  fail "expected a non-retryable failure to return non-zero"
fi
[ "$(call_count)" = "1" ] || fail "expected no retry on a permission error, got $(call_count) calls"
grep -Fq "does not have authorization" "$tmp/err" || fail "expected the swallowed diagnostic to be surfaced"

# 5. Retry is bounded — exhausts attempts and then fails.
scenario "1|ERROR: TooManyRequests" "1|ERROR: TooManyRequests" "1|ERROR: TooManyRequests"
if AZURE_SECRET_SET_ATTEMPTS=3 AZURE_SECRET_SET_BACKOFF=0 \
   azure_containerapp_secret_set_retrying --name app --resource-group rg --secrets "k=v" >/dev/null 2>"$tmp/err"; then
  fail "expected exhaustion of retries to fail"
fi
[ "$(call_count)" = "3" ] || fail "expected exactly 3 attempts, got $(call_count)"
grep -Fq "failed after 3 attempt(s)" "$tmp/err" || fail "expected a final failure message"

# 6. Backoff is honoured between attempts (guards against a hot loop hammering ARM).
scenario "1|ERROR: ServiceUnavailable" "1|ERROR: ServiceUnavailable" "1|ERROR: ServiceUnavailable" "1|ERROR: ServiceUnavailable" "0|"
: > "$sleeps"
AZURE_SECRET_SET_ATTEMPTS=5 AZURE_SECRET_SET_BACKOFF=5 azure_containerapp_secret_set_retrying \
  --name app --resource-group rg --secrets "k=v" >/dev/null 2>&1 || fail "expected eventual success"
[ "$(cat "$sleeps")" = $'5\n10\n20\n40' ] || fail "expected exponential delays 5, 10, 20 and 40 seconds"

# 6b. Large configured delays clamp to 60 seconds and stay capped.
scenario "1|ERROR: ServiceUnavailable" "1|ERROR: ServiceUnavailable" "1|ERROR: ServiceUnavailable" "0|"
: > "$sleeps"
AZURE_SECRET_SET_ATTEMPTS=4 AZURE_SECRET_SET_BACKOFF=40 azure_containerapp_secret_set_retrying \
  --name app --resource-group rg --secrets "k=v" >/dev/null 2>&1 || fail "expected eventual success after capped delays"
[ "$(cat "$sleeps")" = $'40\n60\n60' ] || fail "expected the exponential delay to cap at 60 seconds"

# 7. Attempts env is validated — a junk value must not spin.
scenario "1|ERROR: TooManyRequests"
if AZURE_SECRET_SET_ATTEMPTS=junk azure_containerapp_secret_set_retrying \
   --name app --resource-group rg --secrets "k=v" >/dev/null 2>&1; then
  fail "expected a junk attempts value to fail rather than loop"
fi
[ "$(call_count)" = "1" ] || fail "expected 1 attempt with a junk attempts value, got $(call_count)"

# 8. The secret VALUE never appears in the surfaced diagnostic, even when az
#    echoes it back (the redaction must hold through the real call path).
scenario "1|ERROR: The client 'x' does not have authorization. request body: refreshtoken=super-secret-value-xyz"
azure_containerapp_secret_set_retrying --name app --resource-group rg \
  --secrets "refreshtoken=super-secret-value-xyz" >/dev/null 2>"$tmp/err" || true
if grep -Fq "super-secret-value-xyz" "$tmp/err"; then
  fail "secret value leaked into the error output"
fi
grep -Fq "[redacted]" "$tmp/err" || fail "expected the secret value to be redacted"
grep -Fq "does not have authorization" "$tmp/err" || fail "redaction removed the diagnostic itself"

# 8b. Redaction holds on the retry-warning path too.
scenario "1|ERROR: ContainerAppOperationInProgress refreshtoken=super-secret-value-xyz" "0|"
azure_containerapp_secret_set_retrying --name app --resource-group rg \
  --secrets "refreshtoken=super-secret-value-xyz" >/dev/null 2>"$tmp/err" || fail "expected retry then success"
if grep -Fq "super-secret-value-xyz" "$tmp/err"; then
  fail "secret value leaked into the retry warning"
fi

# 8c. Redaction covers every pair in a multi-secret call, not just the first.
scenario "1|ERROR: ServiceUnavailable a=first-secret-value b=second-secret-value"
azure_containerapp_secret_set_retrying --name app --resource-group rg \
  --secrets "a=first-secret-value" "b=second-secret-value" >/dev/null 2>"$tmp/err" || true
if grep -Fq "first-secret-value" "$tmp/err" || grep -Fq "second-secret-value" "$tmp/err"; then
  fail "a multi-secret call leaked one of its values"
fi

# 9. Short values are not redacted from unrelated text (no over-redaction that
#    would mangle the diagnostic).
scenario "1|ERROR: The client 'x' does not have authorization"
if ! out=$(azure_secret_set_redact "ERROR: does not have authorization" "abc" 2>/dev/null); then
  fail "redact helper should never fail"
fi
[ "$out" = "ERROR: does not have authorization" ] || fail "short value should not be redacted from unrelated text"

# 10. Key Vault uploads carry the value in a restrictive file and never in az argv.
scenario "0|" "0|"
export KV_URL_SENTINEL="upstash-url-sentinel-value"
export KV_TOKEN_SENTINEL="upstash-token-sentinel-value"
azure_keyvault_sync_env_group test-vault \
  upstash-redis-rest-url:KV_URL_SENTINEL \
  upstash-redis-rest-token:KV_TOKEN_SENTINEL || fail "expected Key Vault file sync success"
if grep -Fq 'upstash-url-sentinel-value' "$FAKE_ARGS" || grep -Fq 'upstash-token-sentinel-value' "$FAKE_ARGS"; then
  fail "Key Vault secret value appeared in az argv"
fi
[ "$(cat "$FAKE_FILE_CONTENTS")" = $'upstash-url-sentinel-value\nupstash-token-sentinel-value' ] || \
  fail "Key Vault file sync did not send both expected file contents"
[ -z "${KV_URL_SENTINEL+x}" ] && [ -z "${KV_TOKEN_SENTINEL+x}" ] || \
  fail "source secret variables were not unset before Azure CLI"

# 11. Failed Key Vault upload removes its secret file and directory after the
#     helper's function-local variables have gone out of scope.
scenario "1|ERROR: permission denied"
: > "$FAKE_FILE_PATHS"
export KV_FAILURE_SENTINEL="failure-path-secret-sentinel"
if (
  trap - EXIT
  # The helper path is a temporary fixture path, so ShellCheck cannot resolve it statically.
  # shellcheck disable=SC1090
  source "$helper"
  azure_keyvault_sync_env_group test-vault failure-secret:KV_FAILURE_SENTINEL
) 2>"$tmp/keyvault-failure.err"; then
  fail "expected failed Key Vault sync to return non-zero"
fi
grep -Fq '::error::Failed to sync Key Vault secret failure-secret.' "$tmp/keyvault-failure.err" || \
  fail "failed Key Vault sync did not surface its diagnostic"
if grep -Fq 'failure-path-secret-sentinel' "$tmp/keyvault-failure.err"; then
  fail "failed Key Vault sync exposed its secret value"
fi
failed_secret_file=$(tail -n 1 "$FAKE_FILE_PATHS")
[ -n "$failed_secret_file" ] || fail "fake Azure CLI did not observe the uploaded secret file"
[ ! -e "$failed_secret_file" ] || fail "failed Key Vault sync left its plaintext secret file behind"
failed_secret_dir=${failed_secret_file%/*}
[ ! -e "$failed_secret_dir" ] || fail "failed Key Vault sync left its plaintext temp directory behind"

bash -n "$helper"
echo "Azure secret-sync retry tests passed."
