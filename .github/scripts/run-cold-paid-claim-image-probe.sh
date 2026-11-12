#!/usr/bin/env bash
set -euo pipefail

[[ $# == 6 && $1 == --candidate && $5 == --receipt ]] || {
  echo 'usage: run-cold-paid-claim-image-probe.sh --candidate WORKER_IMAGE PRODUCT_SHA ENGINE_SHA --receipt OUTPUT' >&2
  exit 2
}
image=$2 product=$3 engine=$4 output=$6
[[ $image =~ ^ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:[a-f0-9]{64}$ ]]
[[ $product =~ ^[a-f0-9]{40}$ && $engine =~ ^[a-f0-9]{40}$ ]]
[[ $output == /* && ! -e $output && ! -L $output ]]
root=$(git rev-parse --show-toplevel)
[[ $(git rev-parse HEAD) == "$product" ]]
for file in .github/scripts/run-cold-paid-claim-image-probe.sh .github/scripts/cold-paid-claim-image-probe.mjs; do
  git show "$product:$file" | cmp - "$root/$file"
done
# Use only the current local Unix socket context. No inherited remote overrides.
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix:///* ]]
[[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$product" ]]
[[ $(docker image inspect "$image" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}') == "$engine" ]]
docker image inspect "$image" --format '{{json .RepoDigests}}' | python3 -c 'import json,sys; assert sys.argv[1] in json.load(sys.stdin)' "$image"
postgres=postgres@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
redis_image=redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
docker image inspect "$postgres" "$redis_image" >/dev/null # Never pull implicitly.
tmp=$(mktemp -d)
owner=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
network='' cold_killed=''
containers=()
image_ids=$(docker image inspect "$image" "$postgres" "$redis_image" --format '{{.Id}}')
cleanup() {
  local status=$? id
  trap - EXIT
  if [[ $status != 0 && -f "$tmp/transcript" ]]; then
    tail -40 "$tmp/transcript" >&2
    if [[ -n $cold_killed ]]; then docker logs --tail 30 "$cold_killed" >&2 || true; fi
  fi
  for id in "${containers[@]}"; do
    docker inspect "$id" | python3 -c 'import json,sys; x=json.load(sys.stdin)[0]; assert x["Id"]==sys.argv[1] and x["Config"]["Labels"]["lyrashield.cold-claim-fixture"]==sys.argv[2] and x["Image"] in sys.argv[3].split()' "$id" "$owner" "$image_ids" || exit 1
    docker rm -f -v "$id" >/dev/null || exit 1
    [[ -z $(docker ps -aq --no-trunc --filter "id=$id") ]] || exit 1
  done
  if [[ -n $network ]]; then
    docker network inspect "$network" | python3 -c 'import json,sys; x=json.load(sys.stdin)[0]; assert x["Id"]==sys.argv[1] and x["Labels"]["lyrashield.cold-claim-fixture"]==sys.argv[2] and not x["Containers"]' "$network" "$owner" || exit 1
    docker network rm "$network" >/dev/null || exit 1
  fi
  if [[ $status == 0 ]]; then
    python3 - "$tmp/proof/receipt.json" "$output" "$image" "$engine" "$product" "$root" "$tmp/transcript" "$cold_killed" <<'PY'
import hashlib,json,sys
from pathlib import Path
receipt,output,image,engine,product,root,transcript,killed=sys.argv[1:]
proof=json.loads(Path(receipt).read_text())
assert proof['exitCode']==0 and proof['productRevision']==product and proof['workerDigest']==image.split('@')[1]
assert proof['actualStalledRedelivery'] and proof['attemptsStarted']==2 and proof['stalledCounter']==1
assert proof['billableClaimUnchanged'] and proof['fundedReservationUnchanged'] and proof['userSlotUnchanged']
assert proof['engineCalls']==0 and proof['providerCalls']==0 and proof['executorStopProofAbsent']
proof.update(workerImage=image,engineRevision=engine,harnessRevision=product,cleanupVerified=True,killedWorkerContainerId=killed,killedWorkerExitCode=137,
 transcriptSha256=hashlib.sha256(Path(transcript).read_bytes()).hexdigest(),
 harnessFiles={relative:hashlib.sha256((Path(root)/relative).read_bytes()).hexdigest() for relative in ('.github/scripts/cold-paid-claim-image-probe.mjs','.github/scripts/run-cold-paid-claim-image-probe.sh')},
 limitations=['First callback uses real funded admission and parks before provider dispatch; full initial scan orchestration is not exercised.','No actual accepted provider request or provider settlement is exercised.'])
with open(output,'x') as file: json.dump(proof,file,sort_keys=True);file.write('\n')
print(json.dumps(dict(passed=True,cleanupVerified=True,receipt=output)))
PY
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
network=$(docker network create --label "lyrashield.cold-claim-fixture=$owner" "cold-claim-$owner")
[[ $network =~ ^[a-f0-9]{64}$ ]]
created=
create() {
  created=$(docker create --pull never --label "lyrashield.cold-claim-fixture=$owner" "$@")
  [[ $created =~ ^[a-f0-9]{64}$ ]] || { echo 'Unknown create acknowledgment; reconcile before retry' >&2; exit 1; }
  containers+=("$created")
}
create --network "$network" --network-alias postgres --publish 127.0.0.1::5432 --env POSTGRES_USER=lyrashield --env POSTGRES_PASSWORD=lyrashield --env POSTGRES_DB=lyrashield "$postgres"
pg=$created
create --network "$network" --network-alias redis "$redis_image"
redis=$created
docker start "$pg" "$redis" >/dev/null
ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$pg" pg_isready -U lyrashield -d lyrashield >/dev/null; then ready=true; break; fi
  sleep 0.25
done
[[ $ready == true ]]
port=$(docker inspect "$pg" --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}')
mkdir "$tmp/proof" "$tmp/home"
chmod 0777 "$tmp/proof" # Private parent; contains only disposable identifiers and trap markers.
printf '#!/bin/sh\nprintf unexpected > /proof/engine-called\nexit 97\n' > "$tmp/proof/engine-trap"
chmod 0555 "$tmp/proof/engine-trap"
python3 - "$tmp/prisma.config.mjs" "$root" <<'PY'
import json,sys
from pathlib import Path
path,root=sys.argv[1:]
Path(path).write_text('export default {schema:'+json.dumps(root+'/packages/db/prisma/schema.prisma')+',migrations:{path:'+json.dumps(root+'/packages/db/prisma/migrations')+'},datasource:{url:process.env.DATABASE_URL}}\n')
PY
env -i PATH="$PATH" HOME="$tmp/home" DATABASE_URL="postgresql://lyrashield:lyrashield@127.0.0.1:$port/lyrashield?schema=public" \
  pnpm --filter @lyrashield/db exec prisma migrate deploy --config "$tmp/prisma.config.mjs" > "$tmp/transcript" 2>&1
docker exec -i "$pg" psql -X -U lyrashield -d lyrashield -v ON_ERROR_STOP=1 < "$root/.github/scripts/disposable-worker-rehearsal-role.sql" >> "$tmp/transcript" 2>&1
flags=(--network "$network" --read-only --tmpfs '/tmp:rw,nosuid,nodev,size=128m' --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --pids-limit 256
  --mount "type=bind,src=$root/.github/scripts/cold-paid-claim-image-probe.mjs,dst=/app/apps/worker/.ci-cold-claim.mjs,readonly"
  --mount "type=bind,src=$tmp/proof,dst=/proof" --workdir /app/apps/worker --entrypoint /app/apps/worker/node_modules/.bin/tsx
  --env NODE_ENV=test --env LYRASHIELD_TEST_DB_DISPOSABLE=1
  --env 'DATABASE_URL=postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield?schema=public'
  --env 'DATABASE_SYSTEM_URL=postgresql://lyrashield:lyrashield@postgres:5432/lyrashield?schema=public'
  --env 'DATABASE_DIRECT_URL=postgresql://lyrashield:lyrashield@postgres:5432/lyrashield?schema=public'
  --env REDIS_URL=redis://redis:6379 --env BETTER_AUTH_SECRET=cold-fixture-secret-only-at-least-32-characters
  --env BETTER_AUTH_URL=http://127.0.0.1:3000 --env NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
  --env 'PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com'
  --env "COLD_PROBE_PRODUCT_REVISION=$product" --env "COLD_PROBE_WORKER_DIGEST=${image##*@}")
phase() {
  create "${flags[@]}" "$image" .ci-cold-claim.mjs "$1"
  docker start -a "$created" >> "$tmp/transcript" 2>&1
  [[ $(docker inspect "$created" --format '{{.State.ExitCode}}') == 0 ]]
}
phase init
create "${flags[@]}" "$image" .ci-cold-claim.mjs interrupt
cold_killed=$created
docker start "$cold_killed" >/dev/null
for _attempt in $(seq 1 300); do
  [[ ! -f "$tmp/proof/claimed.json" ]] || break
  [[ $(docker inspect "$cold_killed" --format '{{.State.Running}}') == true ]]
  sleep 0.2
done
[[ -f "$tmp/proof/claimed.json" ]]
docker kill --signal KILL "$cold_killed" >/dev/null
[[ $(docker wait "$cold_killed") == 137 ]]
phase resume
