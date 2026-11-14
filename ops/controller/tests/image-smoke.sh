#!/usr/bin/env bash
# Read-only, network-none smoke of a caller's exact locally built supervisor image.
set -euo pipefail
[[ $# = 1 && $1 =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 2
image=$1
[[ $(docker image inspect --format '{{.Id}}' "$image") = "$image" ]] || exit 2
umask 077
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
arguments=(--rm --network none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=16m,mode=0700 --cap-drop ALL --security-opt no-new-privileges --user 0 --entrypoint node)

# Every executable dependency comes from the immutable image, not a host bind mount.
docker run "${arguments[@]}" "$image" --input-type=module -e '
import { lstatSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
const seen = new Set();
function check(path) {
  const info = lstatSync(path);
  if (info.uid !== 0 || info.gid !== 0) throw Error("Nonroot dependency owner: " + path);
  if (info.isSymbolicLink()) {
    const target = realpathSync(path);
    if (!target.startsWith("/app/")) throw Error("Dependency escaped closure: " + path);
    return check(target);
  }
  if (seen.has(path)) return;
  seen.add(path);
  if ((info.mode & 0o222) || (!info.isDirectory() && !info.isFile())) throw Error("Mutable dependency: " + path);
  if (info.isDirectory()) for (const name of readdirSync(path)) check(join(path,name));
}
check("/app");
for (const file of ["publish-journal-seal.mjs","journal-seal-publication.mjs","publisher-runtime.mjs","native-host-query.ts","native-executor-protocol.ts"])
  if (!lstatSync("/app/src/"+file).isFile()) throw Error("Missing root helper");
const root = readFileSync("/proc/self/mountinfo","utf8").split("\n").map(line=>line.split(" ")).find(row=>row[4]==="/");
if (!root?.[5]?.split(",").includes("ro")) throw Error("Writable root filesystem");
console.log("Immutable root helper closure observed");'

status=0
docker run "${arguments[@]}" "$image" --import tsx /app/src/publish-journal-seal.mjs invalid-source > "$temporary/output" 2> "$temporary/error" || status=$?
[[ $status = 1 && ! -s "$temporary/output" ]]
printf '{"status":"UNKNOWN"}\n' > "$temporary/expected"
cmp "$temporary/error" "$temporary/expected"

status=0
docker run "${arguments[@]}" -i "$image" --import tsx /app/src/native-host-query.ts < /dev/null > "$temporary/output" 2> "$temporary/error" || status=$?
[[ $status = 1 && ! -s "$temporary/output" ]]
printf 'Native action authority unavailable\n' > "$temporary/expected"
cmp "$temporary/error" "$temporary/expected"

# Root can never issue a publication from a writable container filesystem.
status=0
docker run --rm --network none --tmpfs /tmp:rw,nosuid,noexec,size=16m,mode=0700 --cap-drop ALL --security-opt no-new-privileges --user 0 --entrypoint node "$image" --import tsx /app/src/publish-journal-seal.mjs invalid-source > "$temporary/output" 2> "$temporary/error" || status=$?
[[ $status = 1 && ! -s "$temporary/output" ]]
rg -q 'Immutable publisher root filesystem is unavailable' "$temporary/error"
printf '%s\n' 'Publisher and native helpers loaded; malformed authority and writable root denied.'
