import { createHmac } from "node:crypto"
import type Redis from "ioredis"
import { env } from "@lyrashield/config"
import { getAiResultCacheRedisForPurge } from "./redis"

export const AI_RESULT_CACHE_KEY_PREFIX = "lyrashield:ai-cache:v1:triage:"
const PURGE_BATCH_SIZE = 500
const purgeConnections = new WeakMap<Redis, Promise<unknown>>()

/** Key an expiring index by owner and target without storing either identifier. */
export function aiResultCacheTargetIndexKey(
  secret: string,
  workspaceId: string,
  targetId: string
): string {
  const digest = createHmac("sha256", secret)
    .update(`workspace\0${workspaceId}\0target\0${targetId}`)
    .digest("hex")
  return `${AI_RESULT_CACHE_KEY_PREFIX}target:${digest}`
}

/**
 * Purge entries for a workspace using target IDs already known to the caller.
 * This reads bounded per-target indexes; it never scans the Redis database.
 */
export async function purgeAiResultCacheWorkspaceEntries(
  workspaceId: string,
  targetIds: readonly string[]
): Promise<{ available: boolean; targetsVisited: number; entriesDeleted: number }> {
  if (!workspaceId.trim()) throw new TypeError("workspaceId is required")
  const targets = [...new Set(targetIds.filter((targetId) => targetId.trim()))]
  if (targets.length === 0) {
    return { available: false, targetsVisited: 0, entriesDeleted: 0 }
  }

  const secret = env.LYRASHIELD_AI_CACHE_KEY_SECRET ?? ""
  if (Buffer.byteLength(secret, "utf8") < 32) {
    return { available: false, targetsVisited: 0, entriesDeleted: 0 }
  }
  const redis = getAiResultCacheRedisForPurge()
  if (!redis) return { available: false, targetsVisited: 0, entriesDeleted: 0 }

  let connection = purgeConnections.get(redis)
  if (!connection && redis.status === "wait") {
    connection = redis.connect()
    purgeConnections.set(redis, connection)
  }
  if (connection) {
    try {
      await connection
    } finally {
      purgeConnections.delete(redis)
    }
  }
  if (redis.status !== "ready") {
    return { available: false, targetsVisited: 0, entriesDeleted: 0 }
  }

  let entriesDeleted = 0
  for (const targetId of targets) {
    const indexKey = aiResultCacheTargetIndexKey(secret, workspaceId, targetId)
    const keys = await redis.smembers(indexKey)
    for (let offset = 0; offset < keys.length; offset += PURGE_BATCH_SIZE) {
      const batch = keys.slice(offset, offset + PURGE_BATCH_SIZE)
      if (batch.length > 0) entriesDeleted += await redis.del(...batch)
    }
    await redis.del(indexKey)
  }
  return { available: true, targetsVisited: targets.length, entriesDeleted }
}
