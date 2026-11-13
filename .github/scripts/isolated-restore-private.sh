#!/usr/bin/env bash
# Sourced only by the opt-in manual drill. Never upload this private directory.
set -euo pipefail
umask 077

private_directory() {
  local directory="${ISOLATED_RESTORE_TEMP:?}" base="${RUNNER_TEMP:?}"
  # Sourced phases set RUNNER_TEMP to the private directory; cleanup uses the
  # original runner temp. Both must resolve to this exact direct child.
  if [ "$base" = "$directory" ]; then base="$(dirname "$base")"; fi
  [[ "$(basename "$directory")" =~ ^lyrashield-isolated\.[A-Za-z0-9]{8}$ ]] || return 1
  test "$(dirname "$directory")" = "$base" || return 1
  test "$(realpath "$directory")" = "$directory" || return 1
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  test "$(stat -c %u "$directory")" = "$(id -u)" || return 1
  test "$(stat -c %a "$directory")" = 700 || return 1
}

process_identity() {
  local pid="$1" line actual_uid
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" -gt 1 ] || return 1
  actual_uid="$(stat -c %u "/proc/$pid")" || return 1
  test "$actual_uid" = "$(id -u)" || return 1
  line="$(cat "/proc/$pid/stat")" || return 1
  # Fields after the final ')' begin at field3 (state); start time is field22.
  local fields=()
  read -r -a fields <<< "${line##*) }" || return 1
  test "${fields[2]:-}" = "$pid" || return 1 # process group
  test "${fields[3]:-}" = "$pid" || return 1 # session leader created by setsid
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "${fields[19]}"
}

stop_web() {
  local record="$ISOLATED_RESTORE_TEMP/web.identity" pid start extra actual
  [ -e "$record" ] || return 0
  [[ -f "$record" && ! -L "$record" ]] || return 1
  actual="$(stat -c %u "$record")" || return 1
  test "$actual" = "$(id -u)" || return 1
  actual="$(stat -c %a "$record")" || return 1
  test "$actual" = 600 || return 1
  read -r pid start extra < "$record" || return 1
  [[ -z "$extra" && "$pid" =~ ^[1-9][0-9]*$ && "$start" =~ ^[0-9]+$ ]] || return 1
  if ! kill -0 -- "-$pid" 2>/dev/null; then return 0; fi
  # Reject stale/reused leaders rather than signal an unrelated process group.
  actual="$(process_identity "$pid")" || return 1
  test "$actual" = "$start" || return 1
  kill -KILL -- "-$pid"
}

case "${1:-source}" in
  prepare)
    directory="$(mktemp -d "${RUNNER_TEMP:?}/lyrashield-isolated.XXXXXXXX")"
    printf 'ISOLATED_RESTORE_TEMP=%s\n' "$directory" >> "${GITHUB_ENV:?}"
    ;;
  record-web)
    private_directory
    pid="${2:?}"
    start="$(process_identity "$pid")"
    printf '%s %s\n' "$pid" "$start" > "$ISOLATED_RESTORE_TEMP/web.identity"
    ;;
  stop-web)
    private_directory
    stop_web
    ;;
  cleanup)
    # Always steps run on ordinary success/failure; hard runner loss relies on
    # ephemeral runner teardown. No plaintext/error log becomes an artifact.
    if [ -n "${ISOLATED_RESTORE_TEMP:-}" ]; then
      private_directory
      cleanup_status=0
      stop_web || cleanup_status=1
      if [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]]; then
        docker rm -fv "lyrashield-isolated-backup-$GITHUB_RUN_ID" >/dev/null 2>&1 || true
      fi
      docker rm -fv lyrashield-restore-postgres lyrashield-restore-redis >/dev/null 2>&1 || true
      rm -rf -- "$ISOLATED_RESTORE_TEMP"
      rm -f -- "$RUNNER_TEMP/webhook-empty-state-restore-proof.json"
      exit "$cleanup_status"
    fi
    ;;
  source)
    private_directory
    export RUNNER_TEMP="$ISOLATED_RESTORE_TEMP"
    export ISOLATED_RESTORE_BIND=127.0.0.1:
    # Errors can contain production row context or connection details. Capture
    # every command's stdout/stderr privately; Actions receives only exit status.
    exec >> "$RUNNER_TEMP/private-operation.log" 2>&1
    ;;
  *) exit 1 ;;
esac
