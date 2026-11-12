import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/db", () => ({ prisma: { $queryRaw: query } }))
const epoch = "1794480000.123456"
const hash = createHash("sha256").update(epoch).digest("hex")

beforeEach(() => {
  vi.resetModules()
  query.mockReset().mockResolvedValue([{ epoch }])
  vi.stubEnv("LYRASHIELD_COLD_SINGLE_WORKER", "1")
  vi.stubEnv("LYRASHIELD_COLD_DATABASE_EPOCH_SHA256", hash)
})
afterEach(() => vi.unstubAllEnvs())

describe("cold database incarnation guard", () => {
  it("hashes the exact PostgreSQL epoch text through the trusted runtime reader", async () => {
    const { readColdDatabaseEpochHash, assertColdDatabaseEpoch } =
      await import("./cold-database-epoch")
    expect(await readColdDatabaseEpochHash()).toBe(hash)
    await expect(assertColdDatabaseEpoch()).resolves.toBeUndefined()
    expect(query.mock.calls[0]?.[0].join("")).toContain(
      "SELECT extract(epoch from pg_postmaster_start_time())::text AS epoch"
    )
  })

  it.each([undefined, "", "not-a-hash", hash.toUpperCase()])(
    "closes admission without querying for invalid launcher pin %s",
    async (pin) => {
      vi.stubEnv("LYRASHIELD_COLD_DATABASE_EPOCH_SHA256", pin)
      const { assertColdDatabaseEpoch, configureColdDatabaseEpochFailureHandler } =
        await import("./cold-database-epoch")
      const close = vi.fn()
      configureColdDatabaseEpochFailureHandler(close)
      await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
      expect(close).toHaveBeenCalledOnce()
      expect(query).not.toHaveBeenCalled()
    }
  )

  it.each(
    [[], [{ epoch: null }], [{ epoch: "invalid" }], [{ epoch }, { epoch }]].map((rows) => ({
      rows,
    }))
  )("fails closed on an unavailable or ambiguous epoch response", async ({ rows }) => {
    query.mockResolvedValue(rows)
    const { assertColdDatabaseEpoch } = await import("./cold-database-epoch")
    await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
  })

  it("retains the closed latch after a database restart even if the expected pin changes", async () => {
    const { assertColdDatabaseEpoch, configureColdDatabaseEpochFailureHandler } =
      await import("./cold-database-epoch")
    const close = vi.fn()
    configureColdDatabaseEpochFailureHandler(close)
    await assertColdDatabaseEpoch()
    query.mockResolvedValue([{ epoch: "1794481000.123456" }])
    await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
    vi.stubEnv(
      "LYRASHIELD_COLD_DATABASE_EPOCH_SHA256",
      createHash("sha256").update("1794481000.123456").digest("hex")
    )
    await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
    expect(query).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not expose connection errors and stays closed after recovery", async () => {
    const { assertColdDatabaseEpoch, configureColdDatabaseEpochFailureHandler } =
      await import("./cold-database-epoch")
    const close = vi.fn()
    configureColdDatabaseEpochFailureHandler(close)
    query.mockRejectedValue(new Error("private connection details"))
    await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
    query.mockResolvedValue([{ epoch }])
    await expect(assertColdDatabaseEpoch()).rejects.toThrow("admission remains closed")
    expect(query).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not change ordinary worker execution or query its database", async () => {
    vi.stubEnv("LYRASHIELD_COLD_SINGLE_WORKER", undefined)
    vi.stubEnv("LYRASHIELD_COLD_DATABASE_EPOCH_SHA256", undefined)
    const { assertColdDatabaseEpoch } = await import("./cold-database-epoch")
    await expect(assertColdDatabaseEpoch()).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})
