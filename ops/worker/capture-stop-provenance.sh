#!/bin/sh
set -eu

receipt_file="${LYRASHIELD_WORKER_STOP_RECEIPT:-/run/lyrashield/worker-stop-provenance.json}"
container_name="${LYRASHIELD_WORKER_CONTAINER_NAME:-lyrashield-worker}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Worker stop provenance must be captured as root" >&2
  exit 1
fi

case "$receipt_file" in
  /*/worker-stop-provenance.json) ;;
  *) echo "Worker stop provenance receipt path is invalid" >&2; exit 1 ;;
esac
# Invalidate every older receipt before any other fallible capture setup. The
# systemd stop remains fail-open for availability, while the later drill fails
# closed when capture did not complete.
rm -f -- "$receipt_file"
receipt_dir=${receipt_file%/*}
umask 077
mkdir -p "$receipt_dir"
chmod 700 "$receipt_dir"

running=$(docker inspect --format '{{.State.Running}}' "$container_name")
if [ "$running" != "true" ]; then
  echo "Worker stop provenance requires a running container" >&2
  exit 1
fi

read_container_env() {
  name=$1
  values=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_name" |
    sed -n "s/^${name}=//p")
  if [ -z "$values" ] || [ "$(printf '%s\n' "$values" | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "Worker container must contain exactly one ${name}" >&2
    exit 1
  fi
  printf '%s' "$values"
}

is_40_hex() {
  case "$1" in '' | *[!0-9a-fA-F]*) return 1 ;; esac
  [ "${#1}" -eq 40 ]
}

is_sha256() {
  case "$1" in sha256:*) digest=${1#sha256:} ;; *) return 1 ;; esac
  case "$digest" in '' | *[!0-9a-fA-F]*) return 1 ;; esac
  [ "${#digest}" -eq 64 ]
}

sha256_value() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

container_id=$(docker inspect --format '{{.Id}}' "$container_name")
image_reference=$(docker inspect --format '{{.Config.Image}}' "$container_name")
product_revision=$(read_container_env LYRASHIELD_PRODUCT_REVISION)
worker_image_digest=$(read_container_env LYRASHIELD_WORKER_IMAGE_DIGEST)
engine_revision=$(read_container_env LYRASHIELD_ENGINE_REVISION)
database_url=$(read_container_env DATABASE_URL)
database_system_url=$(read_container_env DATABASE_SYSTEM_URL)
redis_url=$(read_container_env REDIS_URL)

case "$container_id" in '' | *[!0-9a-fA-F]*) exit 1 ;; esac
[ "${#container_id}" -eq 64 ] || exit 1
case "$image_reference" in *[!A-Za-z0-9._/:@-]*) exit 1 ;; esac
is_40_hex "$product_revision" || exit 1
is_sha256 "$worker_image_digest" || exit 1
is_40_hex "$engine_revision" || exit 1
case "$image_reference" in *@"$worker_image_digest") ;; *) exit 1 ;; esac

temporary_file=$(mktemp "${receipt_file}.tmp.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
cat >"$temporary_file" <<EOF
{"version":1,"capturedAtEpochSeconds":$(date +%s),"containerId":"$container_id","imageReference":"$image_reference","productRevision":"$product_revision","workerImageDigest":"$worker_image_digest","engineRevision":"$engine_revision","databaseUrlSha256":"$(sha256_value "$database_url")","databaseSystemUrlSha256":"$(sha256_value "$database_system_url")","redisUrlSha256":"$(sha256_value "$redis_url")"}
EOF
chmod 600 "$temporary_file"
chown root:root "$temporary_file"
mv -f "$temporary_file" "$receipt_file"
trap - EXIT HUP INT TERM
