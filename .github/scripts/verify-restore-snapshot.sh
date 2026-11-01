#!/usr/bin/env bash
# Called after isolated-restore-private.sh has redirected stdout/stderr.
# FD 3 is a separate, public diagnostic channel. Emit only fixed labels there.
set -euo pipefail
umask 077
export RESTORE_SNAPSHOT_DIAGNOSTIC_FD=3
stage=archive-binding
integrity_dir=''
finish() {
  local status=$?
  trap - EXIT
  if [ -n "$integrity_dir" ]; then
    if ! rm -rf -- "$integrity_dir"; then status=1; stage=cleanup; fi
  fi
  if [ "$status" -eq 0 ]; then
    printf '%s\n' 'restore/snapshot/complete' >&3
  else
    printf 'restore/snapshot/%s/failed\n' "$stage" >&3
  fi
  exit "$status"
}
trap finish EXIT
# An explicit container override is used only by the owned synthetic fixture.
container="${RESTORE_SNAPSHOT_CONTAINER:-lyrashield-restore-postgres}"
[[ "$container" =~ ^lyrashield-(restore-postgres|snapshot-test-[a-f0-9-]{36})$ ]]
[[ "${BACKUP_DUMP_SHA256:-}" =~ ^[a-f0-9]{64}$ ]]
test "$(sha256sum "${RUNNER_TEMP:?}/backup.dump" | awk '{print $1}')" = "$BACKUP_DUMP_SHA256"
stage=prepare
integrity_dir="$(mktemp -d "$RUNNER_TEMP/snapshot-integrity.XXXXXXXX")"
# Expected content always comes from the verified archive, never a later source
# query. The restored dump uses the same PostgreSQL client and COPY settings.
stage=archive-export
docker exec "$container" pg_restore --data-only --no-owner --no-acl --file=- /tmp/backup.dump > "$integrity_dir/expected-data.sql"
stage=restored-export
docker exec "$container" pg_dump -U restore -d lyrashield_restore --data-only --schema=public --schema=app --no-owner --no-acl > "$integrity_dir/restored-data.sql"
stage=archive-capture
node .github/scripts/restore-snapshot-integrity.mjs capture "$integrity_dir/expected-data.sql" "$BACKUP_DUMP_SHA256" "$integrity_dir/expected-snapshot.json"
stage=restored-capture
node .github/scripts/restore-snapshot-integrity.mjs capture "$integrity_dir/restored-data.sql" "$BACKUP_DUMP_SHA256" "$integrity_dir/restored-snapshot.json"
stage=compare
node .github/scripts/restore-snapshot-integrity.mjs verify "$integrity_dir/expected-snapshot.json" "$integrity_dir/restored-snapshot.json"
