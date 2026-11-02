#!/bin/sh
set -eu

key="lyrashield:scan-admission:stopped"
command_name="${1:-}"
: "${REDIS_URL:?REDIS_URL is required}"

case "$command_name" in
  claim-owned|assert-owned|release-owned)
    [ "$#" -eq 5 ] || { echo "Owned hold requires OWNER PRODUCT_SHA ENGINE_SHA WORKER_DIGEST" >&2; exit 2; }
    module="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/paired-release-hold.mjs"
    node --input-type=module - "$module" "$command_name" "$2" "$3" "$4" "$5" <<'NODE'
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
try {
  const [modulePath, command, ...identity] = process.argv.slice(2);
  const { ownedHold } = await import(pathToFileURL(modulePath));
  const redis = { eval: async (lua, ...args) => execFileSync("redis-cli",
    ["--no-auth-warning", "-u", process.env.REDIS_URL, "--raw", "EVAL", lua, ...args.map(String)],
    { encoding: "utf8", timeout: 10000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  console.log(await ownedHold(redis, command.replace("-owned", ""), ...identity));
} catch {
  console.error("Owned scan admission operation refused; identity or hold state did not match");
  process.exitCode = 1;
}
NODE
    ;;
  stop)
    operator="${2:-}"
    reason="${3:-}"
    if [ -z "$operator" ] || [ -z "$reason" ]; then
      echo "Usage: $0 stop OPERATOR REASON" >&2
      exit 2
    fi
    payload=$(node -e 'process.stdout.write(JSON.stringify({operator:process.argv[1],reason:process.argv[2],stoppedAt:new Date().toISOString()}))' "$operator" "$reason")
    claimed=$(redis-cli --no-auth-warning -u "$REDIS_URL" --raw SET "$key" "$payload" NX)
    [ "$claimed" = OK ] || { echo "Existing admission stop preserved" >&2; exit 1; }
    echo "Scan admission stopped by $operator"
    ;;
  resume)
    operator="${2:-}"
    if [ -z "$operator" ]; then
      echo "Usage: $0 resume OPERATOR" >&2
      exit 2
    fi
    # Atomic ownership check also protects persistent paired-release holds from
    # the legacy manual resume command. No unconditional DEL is permitted.
    released=$(redis-cli --no-auth-warning -u "$REDIS_URL" --raw EVAL '
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or type(value) ~= "table" or value.owner ~= nil or value.reason == "paired-release" or value.operator ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])' 1 "$key" "$operator")
    [ "$released" = 1 ] || { echo "Foreign or owned admission stop preserved" >&2; exit 1; }
    echo "Scan admission resumed by $operator"
    ;;
  status)
    value=$(redis-cli --no-auth-warning --raw -u "$REDIS_URL" GET "$key")
    if [ -n "$value" ]; then
      echo "$value"
      exit 1
    fi
    echo "Scan admission active"
    ;;
  *)
    echo "Usage: $0 stop OPERATOR REASON | resume OPERATOR | status | claim-owned/assert-owned/release-owned OWNER PRODUCT_SHA ENGINE_SHA WORKER_DIGEST" >&2
    exit 2
    ;;
esac
