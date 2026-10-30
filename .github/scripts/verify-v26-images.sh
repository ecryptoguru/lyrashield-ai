#!/bin/sh
set -eu

web=${1:?web digest reference required}
worker=${2:?worker digest reference required}
source=${3:?source revision required}
engine=${4:?engine revision required}
case "$source" in *[!a-f0-9]*|'') exit 1;; esac
case "$engine" in *[!a-f0-9]*|'') exit 1;; esac
[ "${#source}" -eq 40 ] && [ "${#engine}" -eq 40 ] || exit 1
for image in "$web" "$worker"; do
  digest=${image##*@sha256:}
  case "$image" in *@sha256:*) ;; *) exit 1;; esac
  case "$digest" in *[!a-f0-9]*|'') exit 1;; esac
  [ "${#digest}" -eq 64 ] || exit 1
  docker pull "$image" >/dev/null
  [ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$source" ] || exit 1
  [ "$(docker image inspect "$image" --format '{{index .Config.Labels "io.lyrashield.accounting.protocol"}}')" = 'reservations/2' ] || exit 1
done
[ "$(docker image inspect "$worker" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}')" = "$engine" ] || exit 1

# The candidate worker must contain real admission and capacity entrypoints.
# No production credentials or provider network access are supplied.
dummy_secret=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
docker run --rm --network none --entrypoint node --workdir /app/apps/worker \
  --env NODE_ENV=test \
  --env DATABASE_URL=postgresql://example@127.0.0.1:1/example \
  --env BETTER_AUTH_URL=http://127.0.0.1:3100 \
  --env NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 \
  --env LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 \
  --env "BETTER_AUTH_SECRET=$dummy_secret" \
  "$worker" --import tsx --input-type=module -e '
    const db = await import("@lyrashield/db");
    const billing = await import("@lyrashield/billing");
    if (db.SCAN_ACCOUNTING_PROTOCOL !== "reservations/2" ||
        typeof db.createScan !== "function" ||
        typeof db.lockUserScanAdmission !== "function" ||
        typeof db.releaseStoppedScanSlot !== "function" ||
        typeof billing.reserveScanCapacity !== "function" ||
        typeof billing.confirmScanCapacityStopped !== "function") {
      throw new Error("reservation-aware worker entrypoints unavailable");
    }
  '
# Execute the standalone web server from this exact digest without external
# network access. Readiness may be 503 with synthetic credentials; its compiled
# route must expose the protocol imported from the actual admission module.
web_probe="lyrashield-v26-web-$$"
cleanup_web_probe() { docker rm -f "$web_probe" >/dev/null 2>&1 || true; }
trap cleanup_web_probe EXIT HUP INT TERM
docker run -d --name "$web_probe" --network none \
  --env NODE_ENV=production --env HOSTNAME=127.0.0.1 --env PORT=3100 \
  --env DATABASE_URL=postgresql://example@127.0.0.1:1/example \
  --env BETTER_AUTH_URL=http://127.0.0.1:3100 \
  --env NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 \
  --env LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 \
  --env "BETTER_AUTH_SECRET=$dummy_secret" "$web" >/dev/null
web_verified=0
for _ in $(seq 1 30); do
  if docker exec "$web_probe" node --input-type=module -e '
    const response=await fetch("http://127.0.0.1:3100/api/ready",{signal:AbortSignal.timeout(5000)});
    if(![200,503].includes(response.status)||response.headers.get("x-lyrashield-accounting-protocol")!=="reservations/2")process.exit(1);
  ' >/dev/null 2>&1; then web_verified=1; break; fi
  sleep 1
done
[ "$web_verified" = 1 ] || { echo 'Compiled web admission protocol unavailable' >&2; exit 1; }
cleanup_web_probe
trap - EXIT HUP INT TERM
echo V26_IMAGES_QUALIFIED
