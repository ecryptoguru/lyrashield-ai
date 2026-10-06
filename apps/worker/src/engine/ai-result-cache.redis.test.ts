import { createHmac, randomUUID } from "node:crypto"
import Redis from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { canonicalJson } from "@lyrashield/types"
import { aiResultCacheTargetIndexKey } from "@lyrashield/integrations"
import {
  AI_RESULT_CACHE_MAX_BYTES,
  AI_RESULT_CACHE_TTL_SECONDS,
  createAiResultCache,
  type AiResultCacheDescriptor,
} from "./ai-result-cache"

const enabled = process.env.LYRASHIELD_AI_RESULT_CACHE_REDIS_TEST === "1"
const redisUrl = process.env.LYRASHIELD_AI_RESULT_CACHE_TEST_REDIS_URL ?? ""
const secret = "local-redis-test-key-material-0123456789"
const prefix = "lyrashield:ai-cache:v1:triage:"
const modelRoute = "azure_ai/gpt-6-luna"
const checksum = "a".repeat(64)
let redis: Redis | undefined
let cache: ReturnType<typeof createAiResultCache> | undefined
let descriptors: AiResultCacheDescriptor[] = []

function descriptor(): AiResultCacheDescriptor {
  const identity = randomUUID()
  const value: AiResultCacheDescriptor = {
    workspaceId: `redis-test-workspace-${identity}`,
    targetId: `redis-test-target-${identity}`,
    sourceRevision: "b".repeat(40),
    inputChecksum: checksum,
    evidenceChecksums: [checksum],
    engineRevision: "c".repeat(40),
    providerFingerprint: "d".repeat(64),
    modelSettings: {
      modelRoute,
      reasoningEffort: "medium",
      promptCachePolicy: "off",
      maxInputTokens: 12_000,
      maxOutputTokens: 400,
    },
    triagePolicyVersion: "ai-security-triage-policy/1.0",
    schemaVersion: "ai-security-triage/1.0",
    effectiveLimits: {
      maxCalls: 20,
      maxConcurrency: 2,
      maxExcerptBytes: 4096,
      maxInputTokens: 12_000,
      maxOutputTokens: 400,
      maxWallSeconds: 90,
      maxBudgetUsd: 0.25,
    },
  }
  descriptors.push(value)
  return value
}

function artifact() {
  return {
    schemaVersion: "ai-security-triage/1.0",
    status: "COMPLETED",
    terminalReason: null,
    policyVersion: "ai-security-triage-policy/1.0",
    modelRoute,
    inputChecksum: checksum,
    cacheKey: checksum,
    redactionReceipt: {
      policyVersion: "ai-security-triage-policy/1.0",
      inputChecksum: checksum,
      redactedFieldCounts: {},
      boundedExcerptBytes: 4096,
    },
    results: [
      {
        findingIdentity: checksum,
        disposition: "NEEDS_REVIEW",
        confidence: 0.5,
        explanation: "Disposable Redis fixture.",
        evidenceChecksum: checksum,
      },
    ],
  }
}

function usage() {
  return {
    accountingComplete: true,
    requests: 1,
    request_usage_entries: [
      {
        model: modelRoute,
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    ],
    model_usage_buckets: [
      {
        model: modelRoute,
        standard_input_tokens: 100,
        standard_cached_input_tokens: 0,
        standard_cache_write_input_tokens: 0,
        standard_output_tokens: 25,
        long_input_tokens: 0,
        long_cached_input_tokens: 0,
        long_cache_write_input_tokens: 0,
        long_output_tokens: 0,
      },
    ],
  }
}

function entryKey(value: AiResultCacheDescriptor): string {
  const digest = createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
  return `${prefix}${digest}`
}

describe.skipIf(!enabled)("exact AI triage cache against disposable local Redis", () => {
  beforeAll(async () => {
    if (!redisUrl) throw new Error("Local disposable cache Redis URL is required")
    const parsed = new URL(redisUrl)
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
      throw new Error("Cache integration tests require loopback Redis only")
    }
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    await redis.connect()
    cache = createAiResultCache({ redis, secret, mode: "enforce" })
  })

  afterAll(async () => {
    if (redis) {
      for (const value of descriptors) {
        const key = entryKey(value)
        const indexKey = aiResultCacheTargetIndexKey(secret, value.workspaceId, value.targetId)
        const indexedKeys = await redis.smembers(indexKey).catch(() => [])
        if (indexedKeys.length) await redis.del(...indexedKeys)
        await redis.del(key, indexKey)
      }
      await redis.quit()
    }
  })

  it("stores, reads and purges an entry without extending the absolute TTL", async () => {
    if (!redis || !cache) throw new Error("Redis test setup is unavailable")
    const value = descriptor()
    expect(await cache.store(value, artifact(), usage())).toBe(true)
    const key = entryKey(value)
    const indexKey = aiResultCacheTargetIndexKey(secret, value.workspaceId, value.targetId)
    const initialTtl = await redis.pttl(key)

    expect(initialTtl).toBeGreaterThan(0)
    expect(initialTtl).toBeLessThanOrEqual(AI_RESULT_CACHE_TTL_SECONDS * 1_000)
    expect(await cache.lookup(value)).toMatchObject({ outcome: "hit" })
    expect(await redis.pttl(key)).toBeLessThanOrEqual(initialTtl)
    expect(await redis.smembers(indexKey)).toEqual([key])

    const sibling = { ...value, workspaceId: `${value.workspaceId}-other` }
    descriptors.push(sibling)
    expect(await cache.lookup(sibling)).toMatchObject({ outcome: "miss" })
  })

  it("treats corrupt and oversized values as misses", async () => {
    if (!redis || !cache) throw new Error("Redis test setup is unavailable")
    const corrupt = descriptor()
    const corruptKey = entryKey(corrupt)
    await redis.set(corruptKey, "{not-json", "EX", 60)
    expect(await cache.lookup(corrupt)).toMatchObject({ outcome: "miss" })

    const oversized = descriptor()
    await redis.set(entryKey(oversized), "x".repeat(AI_RESULT_CACHE_MAX_BYTES + 1), "EX", 60)
    expect(await cache.lookup(oversized)).toMatchObject({ outcome: "miss" })
  })

  it("misses after Redis expires a value before the descriptor TTL", async () => {
    if (!redis || !cache) throw new Error("Redis test setup is unavailable")
    const value = descriptor()
    expect(await cache.store(value, artifact(), usage())).toBe(true)
    await redis.expire(entryKey(value), 1)
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(await cache.lookup(value)).toMatchObject({ outcome: "miss" })
  }, 5_000)
})
