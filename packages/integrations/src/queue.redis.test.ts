import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeRedis, getRedis } from "./redis"
import {
  isScanWorkerAvailable,
  isTargetRelayWorkerAvailable,
  registerScanWorker,
  unregisterScanWorker,
  SCAN_WORKER_TTL_MS,
} from "./queue"

import { resolveAvailableUrlReview } from "./url-review-admission"

const SCAN_WORKER_REGISTRY_KEY = "lyrashield:scan-workers"
const runRedisTests = process.env.CI === "true"

describe.runIf(runRedisTests)("scan worker Redis scripts", () => {
  const redis = getRedis()

  beforeAll(async () => {
    if (!redis) throw new Error("REDIS_URL is required for Redis integration tests")
    await redis.del(SCAN_WORKER_REGISTRY_KEY)
  })

  afterAll(async () => {
    if (redis) await redis.del(SCAN_WORKER_REGISTRY_KEY)
    await closeRedis()
  })

  it("executes atomic cleanup, count, TTL, and one warmed EVALSHA per operation", async () => {
    if (!redis) throw new Error("REDIS_URL is required for Redis integration tests")

    await redis.zadd(SCAN_WORKER_REGISTRY_KEY, 500, "stale-worker")
    await registerScanWorker("worker-1", 1_000)
    await registerScanWorker("worker-2", 2_000)
    await redis.zadd(SCAN_WORKER_REGISTRY_KEY, 1_500, "new-stale-worker")

    expect(await isScanWorkerAvailable(2_000)).toBe(true)
    expect(await redis.zrange(SCAN_WORKER_REGISTRY_KEY, 0, -1, "WITHSCORES")).toEqual([
      "worker-1",
      "301000",
      "worker-2",
      "302000",
    ])
    expect(await redis.zcard(SCAN_WORKER_REGISTRY_KEY)).toBe(2)

    const ttl = await redis.pttl(SCAN_WORKER_REGISTRY_KEY)
    expect(ttl).toBeGreaterThan(SCAN_WORKER_TTL_MS * 2 - 10_000)
    expect(ttl).toBeLessThanOrEqual(SCAN_WORKER_TTL_MS * 2)

    expect(await isScanWorkerAvailable(301_000)).toBe(true)
    expect(await redis.zrange(SCAN_WORKER_REGISTRY_KEY, 0, -1)).toEqual(["worker-2"])
    expect(await isScanWorkerAvailable(302_000)).toBe(false)
    expect(await redis.zcard(SCAN_WORKER_REGISTRY_KEY)).toBe(0)

    await registerScanWorker("warm-worker", 10_000)
    expect(await isScanWorkerAvailable(10_001)).toBe(true)

    const sendCommand = vi.spyOn(redis, "sendCommand")
    try {
      await registerScanWorker("worker-3", 20_000)
      expect(sendCommand).toHaveBeenCalledTimes(1)
      expect(sendCommand.mock.calls[0]?.[0].name).toBe("evalsha")
      expect(sendCommand.mock.calls[0]?.[0].args.slice(1, 3)).toEqual([
        "1",
        SCAN_WORKER_REGISTRY_KEY,
      ])

      sendCommand.mockClear()
      expect(await isScanWorkerAvailable(20_001)).toBe(true)
      expect(sendCommand).toHaveBeenCalledTimes(1)
      expect(sendCommand.mock.calls[0]?.[0].name).toBe("evalsha")
      expect(sendCommand.mock.calls[0]?.[0].args.slice(1, 3)).toEqual([
        "1",
        SCAN_WORKER_REGISTRY_KEY,
      ])
    } finally {
      sendCommand.mockRestore()
    }
  })
  it("shares live URL availability across interactive, retest and scheduled admission", async () => {
    if (!redis) throw new Error("REDIS_URL is required")
    await redis.del(SCAN_WORKER_REGISTRY_KEY)
    const input = { targetType: "WEB_APP", mode: "STANDARD", hasApiSpec: false }
    expect(await resolveAvailableUrlReview(input)).toMatchObject({
      ok: false,
      code: "TARGET_RELAY_UNAVAILABLE",
    })
    expect(await resolveAvailableUrlReview({ ...input, mode: "SAFE" })).toEqual({
      ok: true,
      engineBacked: false,
    })
    await registerScanWorker("admission-relay", Date.now(), true)
    expect(await resolveAvailableUrlReview(input)).toEqual({ ok: true, engineBacked: true })
    await registerScanWorker("admission-relay", Date.now(), false)
    expect(await resolveAvailableUrlReview(input)).toMatchObject({
      ok: false,
      code: "TARGET_RELAY_UNAVAILABLE",
    })
  })
  it("publishes positive and negative relay capability atomically in the ordinary lease key", async () => {
    if (!redis) throw new Error("REDIS_URL is required for Redis integration tests")
    await redis.del(SCAN_WORKER_REGISTRY_KEY)
    await registerScanWorker("relay-worker", 1_000, true)
    expect(await isTargetRelayWorkerAvailable(2_000)).toBe(true)
    expect(await redis.zrange(SCAN_WORKER_REGISTRY_KEY, 0, -1)).toEqual([
      "relay-worker",
      "~relay~relay-worker",
    ])
    await registerScanWorker("relay-worker", 3_000, false)
    expect(await isTargetRelayWorkerAvailable(3_001)).toBe(false)
    expect(await isScanWorkerAvailable(3_001)).toBe(true)
    expect(await redis.zrange(SCAN_WORKER_REGISTRY_KEY, 0, -1)).toEqual(["relay-worker"])
    await unregisterScanWorker("relay-worker")
    expect(await isScanWorkerAvailable(3_002)).toBe(false)
  })
})
