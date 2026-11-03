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
    case "$reason" in
      paired-release|worker-promotion|webhook-claims-cutover|v26-accounting-cutover)
        echo "Automated admission reason requires its owning release controller" >&2
        exit 2 ;;
    esac
    payload=$(node -e 'const raw=JSON.stringify({operator:process.argv[1],reason:process.argv[2],stoppedAt:new Date().toISOString()}); if(raw.length>4096)process.exit(2); process.stdout.write(raw)' -- "$operator" "$reason")
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
    # Manual receipts are canonical JSON from stop. Reject duplicate members
    # before cjson normalizes them; bind the atomic check to these exact bytes.
    receipt=$(redis-cli --no-auth-warning -u "$REDIS_URL" --raw GET "$key")
    if ! node -e 'try { const raw=process.argv[1]; if(JSON.stringify(JSON.parse(raw))!==raw)process.exit(1); } catch { process.exit(1); }' -- "$receipt"; then
      echo "Ambiguous or malformed admission stop preserved" >&2
      exit 1
    fi
    released=$(redis-cli --no-auth-warning -u "$REDIS_URL" --raw EVAL '
local raw = redis.call("GET", KEYS[1])
if not raw or raw ~= ARGV[2] then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or type(value) ~= "table" then return 0 end
local count = 0
for field in pairs(value) do
  if field ~= "operator" and field ~= "reason" and field ~= "stoppedAt" then return 0 end
  count = count + 1
end
if count ~= 3 or type(value.operator) ~= "string" or value.operator == "" or value.operator ~= ARGV[1] or type(value.reason) ~= "string" or value.reason == "" or type(value.stoppedAt) ~= "string" then return 0 end
local y,m,d,h,n,s = value.stoppedAt:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$")
if not y then return 0 end
y,m,d,h,n,s = tonumber(y),tonumber(m),tonumber(d),tonumber(h),tonumber(n),tonumber(s)
local days = {31,28,31,30,31,30,31,31,30,31,30,31}
if y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0) then days[2] = 29 end
if m < 1 or m > 12 or d < 1 or d > days[m] or h > 23 or n > 59 or s > 59 then return 0 end
return redis.call("DEL", KEYS[1])' 1 "$key" "$operator" "$receipt")
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
