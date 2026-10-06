import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import Redis from "ioredis"

let redis: Redis | null = null
let aiResultCacheRedis: Redis | null = null

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
    connectTimeout: 1_000,
    commandTimeout: 2_000,
    autoResendUnfulfilledCommands: false,
  })

  redis.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message })
  })

  return redis
}

/** Dedicated connection for exact AI-result reuse; never shared with BullMQ or rate limits. */
function getAiResultCacheRedisClient(allowDisabledMode: boolean): Redis | null {
  if (!allowDisabledMode && env.LYRASHIELD_AI_RESULT_CACHE_MODE === "off") return null
  // The cache client intentionally has no reconnect policy. Once ioredis has
  // reached `end`, drop the dead singleton so a later scan can create a fresh
  // bounded client after the application circuit-breaker window expires.
  if (aiResultCacheRedis?.status === "end") aiResultCacheRedis = null
  if (aiResultCacheRedis) return aiResultCacheRedis

  const rawUrl = env.LYRASHIELD_AI_CACHE_REDIS_URL?.trim()
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "rediss:" || !parsed.hostname || !parsed.username || !parsed.password) {
      logger.warn("Exact AI-result reuse is disabled: cache Redis URL is invalid", {
        reason: "tls_url_required",
      })
      return null
    }
  } catch {
    logger.warn("Exact AI-result reuse is disabled: cache Redis URL is invalid", {
      reason: "url_invalid",
    })
    return null
  }

  aiResultCacheRedis = new Redis(rawUrl, {
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 500,
    commandTimeout: 500,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => null,
    reconnectOnError: () => false,
  })
  aiResultCacheRedis.on("error", (error) => {
    logger.warn("Exact AI-result cache Redis command failed", {
      errorType: error.name,
    })
  })
  return aiResultCacheRedis
}

export function getAiResultCacheRedis(): Redis | null {
  return getAiResultCacheRedisClient(false)
}

/** Dedicated client for purging known cache namespaces after target deletion. */
export function getAiResultCacheRedisForPurge(): Redis | null {
  return getAiResultCacheRedisClient(true)
}

export function closeRedis(): Promise<"OK" | void> {
  if (!redis) return Promise.resolve()
  const client = redis
  redis = null
  return client.quit().catch((err) => {
    logger.error("Failed to close Redis connection", { error: err.message })
  })
}

export function closeAiResultCacheRedis(): Promise<"OK" | void> {
  if (!aiResultCacheRedis) return Promise.resolve()
  const client = aiResultCacheRedis
  aiResultCacheRedis = null
  return client.quit().catch((error) => {
    logger.warn("Failed to close exact AI-result cache Redis connection", {
      errorType: error instanceof Error ? error.name : "unknown",
    })
  })
}
