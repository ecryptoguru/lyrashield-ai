#!/bin/sh
set -eu

CDPATH=
export CDPATH
repo_root=$(cd -- "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
fake_bin="$test_dir/bin"
receipt="$test_dir/run/worker-stop-provenance.json"
mkdir -p "$fake_bin"

cat >"$fake_bin/id" <<'EOF'
#!/bin/sh
printf '%s\n' "${FAKE_UID:-0}"
EOF
cat >"$fake_bin/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$fake_bin/chmod" <<'EOF'
#!/bin/sh
[ "${CHMOD_FAIL:-0}" != "1" ] || exit 1
/bin/chmod "$@"
EOF
cat >"$fake_bin/date" <<'EOF'
#!/bin/sh
printf '%s\n' 1787629200
EOF
cat >"$fake_bin/docker" <<'EOF'
#!/bin/sh
[ "${4:-}" != "missing" ] || exit 1
case "$3" in
  '{{.State.Running}}') printf '%s\n' true ;;
  '{{.Id}}') printf '%064d\n' 0 ;;
  '{{.Config.Image}}') printf '%s\n' "worker@sha256:$(printf '%064d' 0)" ;;
  '{{range .Config.Env}}{{println .}}{{end}}')
    cat <<ENV
LYRASHIELD_PRODUCT_REVISION=$(printf '%040d' 0)
LYRASHIELD_WORKER_IMAGE_DIGEST=sha256:$(printf '%064d' 0)
LYRASHIELD_ENGINE_REVISION=$(printf '%040d' 1)
DATABASE_URL=postgresql://user:secret@db.example/prod
DATABASE_SYSTEM_URL=postgresql://owner:secret@db.example/prod
REDIS_URL=rediss://default:secret@redis.example:6380/0
ENV
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake_bin"/*

PATH="$fake_bin:$PATH" \
  LYRASHIELD_WORKER_STOP_RECEIPT="$receipt" \
  sh "$repo_root/ops/worker/capture-stop-provenance.sh"

if permissions=$(stat -c '%a' "$receipt" 2>/dev/null); then
  :
else
  permissions=$(stat -f '%Lp' "$receipt")
fi
test "$permissions" = 600
# shellcheck disable=SC2016
node -e '
  const fs = require("node:fs");
  const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (receipt.version !== 1 || !receipt.imageReference.endsWith(`@${receipt.workerImageDigest}`)) process.exit(1);
  if (JSON.stringify(receipt).includes("secret")) process.exit(1);
' "$receipt"

if PATH="$fake_bin:$PATH" FAKE_UID=1000 LYRASHIELD_WORKER_STOP_RECEIPT="$receipt" \
  sh "$repo_root/ops/worker/capture-stop-provenance.sh" >/dev/null 2>&1; then
  echo "Non-root provenance capture unexpectedly succeeded" >&2
  exit 1
fi

printf '%s\n' stale >"$receipt"
if PATH="$fake_bin:$PATH" LYRASHIELD_WORKER_STOP_RECEIPT="$receipt" \
  LYRASHIELD_WORKER_CONTAINER_NAME=missing \
  sh "$repo_root/ops/worker/capture-stop-provenance.sh" >/dev/null 2>&1; then
  echo "Failed capture unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$receipt"

printf '%s\n' stale >"$receipt"
if PATH="$fake_bin:$PATH" CHMOD_FAIL=1 LYRASHIELD_WORKER_STOP_RECEIPT="$receipt" \
  sh "$repo_root/ops/worker/capture-stop-provenance.sh" >/dev/null 2>&1; then
  echo "Capture with failed directory hardening unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$receipt"

grep -Fqx 'ExecStop=-/usr/local/libexec/lyrashield-capture-worker-stop-provenance' \
  "$repo_root/ops/worker/lyrashield-worker.service"
grep -Fqx 'ExecStopPost=-/usr/bin/docker rm --force lyrashield-worker' \
  "$repo_root/ops/worker/lyrashield-worker.service"

echo "worker stop provenance test passed"
