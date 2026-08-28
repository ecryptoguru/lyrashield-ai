#!/bin/sh
set -eu

if [ "${1:-}" = "--" ]; then
  shift
fi

image="${1:-lyrashieldai-worker:latest}"
expected_app_revision="${2:-}"
expected_engine_revision="${3:-}"
configured_user="$(docker image inspect "$image" --format '{{.Config.User}}')"

case "$configured_user" in
  "" | root | 0 | 0:*)
    echo "worker image must configure a non-root user (found: ${configured_user:-unset})" >&2
    exit 1
    ;;
esac

if [ -n "$expected_app_revision" ]; then
  actual_app_revision="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  if [ "$actual_app_revision" != "$expected_app_revision" ]; then
    echo "worker image app revision mismatch (expected: $expected_app_revision, found: ${actual_app_revision:-unset})" >&2
    exit 1
  fi
fi

if [ -n "$expected_engine_revision" ]; then
  actual_engine_revision="$(docker image inspect "$image" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}')"
  if [ "$actual_engine_revision" != "$expected_engine_revision" ]; then
    echo "worker image engine revision mismatch (expected: $expected_engine_revision, found: ${actual_engine_revision:-unset})" >&2
    exit 1
  fi
fi

docker image inspect "$image" --format 'image_id={{.Id}} size_bytes={{.Size}} user={{.Config.User}}'

docker run --rm --entrypoint sh "$image" -c '
  set -eu

  command -v lyrashield >/dev/null
  lyrashield --version
  test "$(id -u)" != 0
  test ! -e /opt/lyrashield-engine
  test ! -e /opt/lyrashield-venv/src
  test ! -e /app/.env

  for asset in \
    run-worker.sh \
    refresh-secrets.sh \
    refresh-egress.sh \
    capture-stop-provenance.sh \
    lyrashield-worker.service \
    lyrashield-worker-secrets.service \
    lyrashield-worker-egress.service \
    lyrashield-worker-egress-refresh.service \
    lyrashield-worker-egress-refresh.timer
  do
    test -f "/opt/lyrashield-worker-host/$asset"
    test ! -L "/opt/lyrashield-worker-host/$asset"
  done

  if find /app /opt/lyrashield-venv -type f -name .env -print -quit | grep -q .; then
    echo "worker image contains an environment file" >&2
    exit 1
  fi

  if find /opt/lyrashield-venv -type d -path "*/interface/viewer/frontend" -print -quit | grep -q .; then
    echo "worker image contains viewer frontend source" >&2
    exit 1
  fi

  if find /app/apps/worker -type f \( -name "*.test.ts" -o -name "*.test.tsx" \) -print -quit | grep -q .; then
    echo "worker image contains product test source" >&2
    exit 1
  fi

  python3 <<PY
from pathlib import Path
import re
import sys

private_key = re.compile(
    rb"-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----\\s+"
    rb"[A-Za-z0-9+/=\\r\\n]{64,}"
    rb"-----END \\1PRIVATE KEY-----"
)
violations = []
for root in (Path("/app"), Path("/opt/lyrashield-venv")):
    for path in root.rglob("*"):
        try:
            if not path.is_file():
                continue
            if path.suffix == ".key":
                violations.append(str(path))
                continue
            if path.stat().st_size <= 2 * 1024 * 1024 and private_key.search(path.read_bytes()):
                violations.append(str(path))
        except OSError:
            continue

if violations:
    print("worker image contains private-key material:", file=sys.stderr)
    print("\\n".join(violations), file=sys.stderr)
    raise SystemExit(1)
PY

  python3 <<PY
import hashlib
import importlib.metadata as metadata

rows = sorted(
    (distribution.metadata.get("Name") or "") + "==" + distribution.version
    for distribution in metadata.distributions()
)
payload = "\\n".join(rows).encode()
print(
    "python_distributions=%d dependency_manifest_sha256=%s"
    % (len(rows), hashlib.sha256(payload).hexdigest())
)
PY
  echo worker-image-policy=ok
'
