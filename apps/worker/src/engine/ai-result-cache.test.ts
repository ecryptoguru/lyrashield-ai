import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { aiResultCacheTargetIndexKey } from "@lyrashield/integrations"
import type { EngineTriageArtifact } from "@lyrashield/security/ai-security"
import {
  createAiResultCache,
  createProcessSingleFlight,
  parseAiResultReuseReceipt,
  sha256CanonicalJson,
  type AiResultCacheDescriptor,
  type AiResultCacheRedis,
  type AiResultCacheTransaction,
} from "./ai-result-cache"

const inputChecksum = createHash("sha256").update("input").digest("hex")
const findingChecksum = createHash("sha256").update("finding").digest("hex")
const engineRevision = "a".repeat(40)
const providerFingerprint = "b".repeat(64)

function descriptor(overrides: Partial<AiResultCacheDescriptor> = {}): AiResultCacheDescriptor {
  return {
    workspaceId: "workspace-1",
    targetId: "target-1",
    sourceRevision: "c".repeat(40),
    inputChecksum,
    evidenceChecksums: [findingChecksum],
    engineRevision,
    providerFingerprint,
    modelSettings: {
      modelRoute: "azure_ai/gpt-6-luna",
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
    ...overrides,
  }
}

function artifact(overrides: Partial<EngineTriageArtifact> = {}): EngineTriageArtifact {
  return {
    schemaVersion: "ai-security-triage/1.0",
    status: "COMPLETED",
    terminalReason: null,
    policyVersion: "ai-security-triage-policy/1.0",
    modelRoute: "azure_ai/gpt-6-luna",
    inputChecksum,
    cacheKey: "d".repeat(64),
    redactionReceipt: {
      policyVersion: "ai-security-triage-policy/1.0",
      inputChecksum,
      redactedFieldCounts: {},
      boundedExcerptBytes: 4096,
    },
    results: [
      {
        findingIdentity: findingChecksum,
        disposition: "NEEDS_REVIEW",
        confidence: 0.5,
        explanation: "Review the deterministic candidate.",
        evidenceChecksum: findingChecksum,
      },
    ],
    ...overrides,
  }
}

function completeUsage() {
  return {
    accountingComplete: true,
    requests: 1,
    request_usage_entries: [
      {
        model: "azure_ai/gpt-6-luna",
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    ],
    model_usage_buckets: [
      {
        model: "azure_ai/gpt-6-luna",
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

class FakeRedis implements AiResultCacheRedis {
  values = new Map<string, string>()
  sets = new Map<string, Set<string>>()
  fail = false
  get = vi.fn(async (key: string) => {
    if (this.fail) throw new Error("private connection detail")
    return this.values.get(key) ?? null
  })
  set = vi.fn(async (key: string, value: string, _mode: "EX", _ttl: number, _nx: "NX") => {
    if (this.fail) throw new Error("private connection detail")
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return "OK"
  })
  multi = vi.fn(() => {
    const commands: Array<() => Promise<unknown>> = []
    let transaction: AiResultCacheTransaction
    transaction = {
      set: (key, value, mode, ttl, condition) => {
        commands.push(() => this.set(key, value, mode, ttl, condition))
        return transaction
      },
      sadd: (key, member) => {
        commands.push(async () => {
          let members = this.sets.get(key)
          if (!members) {
            members = new Set<string>()
            this.sets.set(key, members)
          }
          const originalSize = members.size
          members.add(member)
          return members.size === originalSize ? 0 : 1
        })
        return transaction
      },
      expire: () => {
        commands.push(async () => 1)
        return transaction
      },
      exec: async () =>
        Promise.all(
          commands.map(async (command) => {
            try {
              return [null, await command()] as [Error | null, unknown]
            } catch (error) {
              return [error as Error, null] as [Error | null, unknown]
            }
          })
        ),
    }
    return transaction
  })
  smembers = vi.fn(async (key: string) => [...(this.sets.get(key) ?? [])])
  del = vi.fn(async (...keys: string[]) => {
    let removed = 0
    for (const key of keys) {
      removed += Number(this.values.delete(key))
      removed += Number(this.sets.delete(key))
    }
    return removed
  })
}

describe("exact AI triage result cache", () => {
  it("accepts the same canonical overlay digest emitted by the Python CLI", () => {
    const pythonArtifact = artifact({
      inputChecksum: "a".repeat(64),
      cacheKey: "d".repeat(64),
      redactionReceipt: {
        policyVersion: "ai-security-triage-policy/1.0",
        inputChecksum: "a".repeat(64),
        redactedFieldCounts: {},
        boundedExcerptBytes: 4096,
      },
      results: [
        {
          findingIdentity: "b".repeat(64),
          disposition: "NEEDS_REVIEW",
          confidence: 0.5,
          explanation: "Review the deterministic candidate.",
          evidenceChecksum: "b".repeat(64),
        },
      ],
    })
    const pythonChecksum = "838c9a64a6349d9f8830821fdf0893550311a64d36dc53340b99ad19e1164230"

    expect(sha256CanonicalJson(pythonArtifact)).toBe(pythonChecksum)
    expect(
      parseAiResultReuseReceipt(
        {
          version: "ai-result-reuse/1.0",
          artifactSha256: pythonChecksum,
          createdAt: "2026-10-03T00:00:00.000Z",
          expiresAt: "2026-10-04T00:00:00.000Z",
          currentProviderRequests: 0,
          currentProviderCostUsd: 0,
        },
        pythonArtifact,
        Date.parse("2026-10-03T00:00:01.000Z")
      )
    ).not.toBeNull()
  })

  it("collapses identical process-local work and does not cancel the leader with a follower", async () => {
    const flight = createProcessSingleFlight<number>()
    let finish!: (value: number) => void
    let calls = 0
    const work = () => {
      calls += 1
      return new Promise<number>((resolve) => {
        finish = resolve
      })
    }

    const leader = flight.run("same-descriptor", work, { timeoutMs: 1_000 })
    await Promise.resolve()
    const follower = flight.run("same-descriptor", work, {
      timeoutMs: 1_000,
      shouldCancel: async () => true,
    })
    await expect(follower).resolves.toMatchObject({ shared: true, cancelled: true })
    const sharedFollower = flight.run("same-descriptor", work, { timeoutMs: 1_000 })
    finish(7)

    await expect(leader).resolves.toEqual({ shared: false, value: 7 })
    await expect(sharedFollower).resolves.toEqual({ shared: true, value: 7 })
    expect(calls).toBe(1)
  })

  it("stores only validated completed overlays and returns a zero-request reuse receipt", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    const now = Date.parse("2026-10-03T00:00:00.000Z")

    await cache.store(descriptor(), artifact(), completeUsage(), now)
    const result = await cache.lookup(descriptor(), now + 1_000)

    expect(result.outcome).toBe("hit")
    expect(result.reuseReceipt).toMatchObject({
      version: "ai-result-reuse/1.0",
      currentProviderRequests: 0,
      currentProviderCostUsd: 0,
      createdAt: "2026-10-03T00:00:00.000Z",
      expiresAt: "2026-10-04T00:00:00.000Z",
    })
    expect(result.artifact?.status).toBe("COMPLETED")
    expect(JSON.stringify([...redis.values.values()])).not.toContain("accountingComplete")
    expect(JSON.stringify([...redis.values.values()])).toContain("Review the deterministic")
    expect(JSON.stringify([...redis.values.values()])).not.toContain("request_usage_entries")
  })

  it("indexes cache entries under an opaque workspace-target key", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })

    expect(await cache.store(descriptor(), artifact(), completeUsage())).toBe(true)

    const indexKey = aiResultCacheTargetIndexKey("k".repeat(32), "workspace-1", "target-1")
    const storedKey = [...redis.values.keys()][0]
    expect(indexKey).not.toContain("workspace-1")
    expect(indexKey).not.toContain("target-1")
    expect(redis.sets.get(indexKey)).toEqual(new Set([storedKey]))
    expect(aiResultCacheTargetIndexKey("k".repeat(32), "workspace-2", "target-1")).not.toBe(
      indexKey
    )
  })

  it("records cache commands and payload bytes for private per-scan economics", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    const deltas: Array<{
      readCommands: number
      writeCommands: number
      bytesRead: number
      bytesWritten: number
    }> = []
    const record = (delta: (typeof deltas)[number]) => deltas.push(delta)

    await cache.store(
      descriptor(),
      artifact(),
      completeUsage(),
      Date.parse("2026-10-03T00:00:00.000Z"),
      undefined,
      record
    )
    const storedBytes = Buffer.byteLength([...redis.values.values()][0] ?? "", "utf8")
    expect(deltas).toContainEqual({
      readCommands: 0,
      writeCommands: 3,
      bytesRead: 0,
      bytesWritten: storedBytes,
    })

    deltas.length = 0
    await cache.lookup(descriptor(), Date.parse("2026-10-03T00:00:01.000Z"), undefined, record)

    expect(deltas).toEqual([
      { readCommands: 1, writeCommands: 0, bytesRead: 0, bytesWritten: 0 },
      { readCommands: 0, writeCommands: 0, bytesRead: storedBytes, bytesWritten: 0 },
    ])
  })

  it("misses when any ownership, source, evidence, model, or policy identity changes", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    await cache.store(descriptor(), artifact(), completeUsage(), Date.now())

    const changed = await cache.lookup(descriptor({ targetId: "target-2" }))

    expect(changed.outcome).toBe("miss")
    expect(changed.artifact).toBeUndefined()
  })

  it("refuses incomplete accounting, non-completed results, and evidence-join mismatches", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })

    await cache.store(descriptor(), artifact(), { ...completeUsage(), accountingComplete: false })
    await cache.store(
      descriptor({ targetId: "target-disabled" }),
      artifact({ status: "DISABLED" }),
      completeUsage()
    )
    await cache.store(
      descriptor({ targetId: "target-mismatch" }),
      artifact({ results: [{ ...artifact().results[0]!, evidenceChecksum: "e".repeat(64) }] }),
      completeUsage()
    )

    const missingCacheWrite = completeUsage()
    delete (
      missingCacheWrite.request_usage_entries[0]!.input_tokens_details as Record<string, unknown>
    )["cache_write_tokens"]
    await cache.store(
      descriptor({ targetId: "target-incomplete-cache-bucket" }),
      artifact(),
      missingCacheWrite
    )

    expect(redis.set).not.toHaveBeenCalled()
  })

  it("accepts complete request receipts when derived long-context buckets are absent", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    const usage = completeUsage()
    delete (usage as Record<string, unknown>).model_usage_buckets

    expect(await cache.store(descriptor(), artifact(), usage)).toBe(true)
  })

  it("does not extend the original TTL on reads and rejects expired entries", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    const now = Date.now()
    await cache.store(descriptor(), artifact(), completeUsage(), now)

    const expired = await cache.lookup(descriptor(), now + 24 * 60 * 60 * 1000 + 1)

    expect(expired.outcome).toBe("miss")
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it("fails open and opens a bounded circuit after three Redis errors", async () => {
    const redis = new FakeRedis()
    redis.fail = true
    const cache = createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" })
    const warn = vi.fn()

    for (let index = 0; index < 3; index += 1) {
      await cache.lookup(descriptor(), Date.now(), warn)
    }
    const before = redis.get.mock.calls.length
    const result = await cache.lookup(descriptor(), Date.now(), warn)

    expect(result.outcome).toBe("unavailable")
    expect(redis.get).toHaveBeenCalledTimes(before)
    expect(warn).toHaveBeenCalledWith("redis_error")
  })

  it("rejects cache keys without minimum key material or required provenance", async () => {
    const redis = new FakeRedis()
    const cache = createAiResultCache({ redis, secret: "short", mode: "enforce" })

    expect((await cache.lookup(descriptor())).outcome).toBe("disabled")
    expect(
      (
        await createAiResultCache({ redis, secret: "k".repeat(32), mode: "enforce" }).lookup(
          descriptor({ engineRevision: "" })
        )
      ).outcome
    ).toBe("disabled")
  })
})
