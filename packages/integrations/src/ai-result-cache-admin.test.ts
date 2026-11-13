import { beforeEach, describe, expect, it, vi } from "vitest"

const { env, redis } = vi.hoisted(() => ({
  env: {
    LYRASHIELD_AI_CACHE_KEY_SECRET: "k".repeat(32),
  },
  redis: {
    status: "ready",
    connect: vi.fn<() => Promise<void>>(),
    smembers: vi.fn<(...args: string[]) => Promise<string[]>>(),
    del: vi.fn<(...keys: string[]) => Promise<number>>(),
  },
}))

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("./redis", () => ({ getAiResultCacheRedisForPurge: () => redis }))

import {
  aiResultCacheTargetIndexKey,
  purgeAiResultCacheWorkspaceEntries,
} from "./ai-result-cache-admin"

describe("exact AI-result cache purge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.status = "ready"
    redis.connect.mockImplementation(async () => {
      redis.status = "ready"
    })
    redis.smembers.mockResolvedValue([])
    redis.del.mockResolvedValue(0)
  })

  it("connects a cold client before deleting cached target results", async () => {
    redis.status = "wait"
    redis.smembers.mockImplementation(async () => {
      if (redis.status !== "ready") throw new Error("Stream isn't writeable")
      return ["cached-entry"]
    })
    redis.del.mockImplementation(async (...keys) => keys.length)
    await expect(purgeAiResultCacheWorkspaceEntries("workspace-1", ["target-1"])).resolves.toEqual({
      available: true,
      targetsVisited: 1,
      entriesDeleted: 1,
    })
  })

  it("uses an opaque workspace-target index and deletes in bounded batches", async () => {
    const entries = Array.from({ length: 1_003 }, (_, index) => `cache-key-${index}`)
    redis.smembers.mockResolvedValue(entries)
    redis.del.mockImplementation(async (...keys) => keys.length)
    const indexKey = aiResultCacheTargetIndexKey("k".repeat(32), "workspace-1", "target-1")

    const result = await purgeAiResultCacheWorkspaceEntries("workspace-1", ["target-1"])

    expect(indexKey).not.toContain("workspace-1")
    expect(indexKey).not.toContain("target-1")
    expect(redis.smembers).toHaveBeenCalledWith(indexKey)
    expect(redis.del).toHaveBeenCalledTimes(4)
    expect(redis.del.mock.calls.slice(0, 3).map((keys) => keys.length)).toEqual([500, 500, 3])
    expect(redis.del).toHaveBeenLastCalledWith(indexKey)
    expect(result).toEqual({ available: true, targetsVisited: 1, entriesDeleted: 1_003 })
  })

  it("deduplicates known targets and never discovers keys with a database scan", async () => {
    const result = await purgeAiResultCacheWorkspaceEntries("workspace-1", ["target-1", "target-1"])

    expect(redis.smembers).toHaveBeenCalledTimes(1)
    expect(redis.smembers).toHaveBeenCalledWith(
      aiResultCacheTargetIndexKey("k".repeat(32), "workspace-1", "target-1")
    )
    expect(redis.del).toHaveBeenCalledWith(
      aiResultCacheTargetIndexKey("k".repeat(32), "workspace-1", "target-1")
    )
    expect(result).toEqual({ available: true, targetsVisited: 1, entriesDeleted: 0 })
  })

  it("does not connect or purge when no target IDs are supplied", async () => {
    await expect(purgeAiResultCacheWorkspaceEntries("workspace-1", [])).resolves.toEqual({
      available: false,
      targetsVisited: 0,
      entriesDeleted: 0,
    })
    expect(redis.smembers).not.toHaveBeenCalled()
  })

  it("rejects an empty workspace before reading Redis", async () => {
    await expect(purgeAiResultCacheWorkspaceEntries(" ", ["target-1"])).rejects.toThrow(
      "workspaceId is required"
    )
    expect(redis.smembers).not.toHaveBeenCalled()
  })
})
