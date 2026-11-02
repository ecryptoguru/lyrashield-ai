import Redis from "ioredis"

/** Written only by the launcher after verifying its newly created Redis service. */
export const USER_SCAN_SLOT_REDIS_MARKER = "lyrashield:test-fixture:user-scan-slot"

export async function assertUserScanSlotRedisFixture(
  redisUrl: string,
  expectedIdentity: string | undefined
): Promise<void> {
  if (
    !expectedIdentity ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedIdentity)
  )
    throw new Error("requires explicit task-owned Redis fixture identity")
  const url = new URL(redisUrl)
  if (url.protocol !== "redis:" || url.hostname !== "127.0.0.1")
    throw new Error("requires task-owned loopback Redis fixture")
  // This probe performs only GET. An inherited local endpoint must never be
  // marked as owned by the suite or receive canonical queue/registry writes.
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  })
  try {
    await redis.connect()
    if ((await redis.get(USER_SCAN_SLOT_REDIS_MARKER)) !== expectedIdentity)
      throw new Error("Redis fixture identity does not match the task-owned service")
  } finally {
    redis.disconnect()
  }
}

interface QueueFixture {
  registerScanWorker(workerId: string): Promise<void>
  unregisterScanWorker(workerId: string): Promise<void>
  getScanQueue(): {
    getJob(scanId: string): Promise<{ remove(): Promise<unknown> } | undefined>
  }
}

export async function withUserScanSlotQueueFixture(
  integrations: QueueFixture,
  workerId: string,
  scanId: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await integrations.registerScanWorker(workerId)
    await run()
  } finally {
    try {
      await (await integrations.getScanQueue().getJob(scanId))?.remove()
    } finally {
      await integrations.unregisterScanWorker(workerId)
    }
  }
}
