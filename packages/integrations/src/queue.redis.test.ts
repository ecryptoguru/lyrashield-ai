import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeRedis, getRedis } from "./redis"
import { isScanWorkerAvailable, registerScanWorker, SCAN_WORKER_TTL_MS } from "./queue"

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
})
