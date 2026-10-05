// Fixed probe executed in the pinned observer container. Lua compares exactly
// one Redis key, preserving foreign stops and never deleting queue data.
import {
  requireValue,
  canonical,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const [phase, raw] = process.argv.slice(2)
const stop = JSON.parse(raw || "null")
requireValue(
  ["claim", "assert", "release"].includes(phase) &&
    stop?.reason === "webhook-empty-state" &&
    stop.operator === "github-actions" &&
    /^[1-9][0-9]*:[1-9][0-9]*$/.test(stop.owner || "") &&
    canonical(stop) === raw,
  "Invalid owned admission operation"
)
const Redis = createRequire("/app/apps/worker/package.json")("ioredis")
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  commandTimeout: 5000,
})
try {
  const script =
    phase === "claim"
      ? "local v=redis.call('GET',KEYS[1]); if v==ARGV[1] then return 1 end; if v then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); return 1"
      : phase === "release"
        ? "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('DEL',KEYS[1]); return 1"
        : "if redis.call('GET',KEYS[1])==ARGV[1] then return 1 else return 0 end"
  requireValue(
    (await redis.eval(script, 1, "lyrashield:scan-admission:stopped", raw)) === 1,
    "Foreign or changed admission stop"
  )
} finally {
  await redis.quit()
}
