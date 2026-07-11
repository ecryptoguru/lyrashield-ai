import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import Redis from "ioredis"

let redis: Redis | null = null

export function getRedis(): Redis | null {
  if (redis) return redis

  const url = env.REDIS_URL
  if (!url) {
    return null
  }

  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  })

  redis.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message })
  })

  return redis
}

export function closeRedis(): Promise<"OK" | void> {
  if (!redis) return Promise.resolve()
  const client = redis
  redis = null
  return client.quit().catch((err) => {
    logger.error("Failed to close Redis connection", { error: err.message })
  })
}
