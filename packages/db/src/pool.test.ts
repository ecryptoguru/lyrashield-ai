import pg from "pg"
import { logger } from "@lyrashield/logger"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoundedPgAdapter, observePgPoolConnections, resolveDbPoolMax } from "./pool"

function createTestPool(connect: pg.Pool["connect"]): pg.Pool {
  const pool = new pg.Pool()
  Object.defineProperties(pool, {
    totalCount: { configurable: true, value: 3 },
    idleCount: { configurable: true, value: 1 },
    waitingCount: { configurable: true, value: 2 },
  })
  pool.connect = connect
  return pool
}

afterEach(() => vi.restoreAllMocks())

describe("resolveDbPoolMax", () => {
  it("defaults to 4 when the env override is unset", () => {
    expect(resolveDbPoolMax({})).toBe(4)
  })

  it("honors a valid LYRASHIELD_DB_POOL_MAX override", () => {
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "2" })).toBe(2)
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "8" })).toBe(8)
  })

  it("falls back to the default on unparseable or non-positive values (never disables the cap)", () => {
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "not-a-number" })).toBe(4)
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "0" })).toBe(4)
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "-3" })).toBe(4)
    expect(resolveDbPoolMax({ LYRASHIELD_DB_POOL_MAX: "" })).toBe(4)
  })
})

describe("createBoundedPgAdapter", () => {
  it.each(["db", "db:system"] as const)(
    "enforces verified Supabase TLS in the %s pool",
    async (scope) => {
      const raw =
        "postgres://runtime:synthetic@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true"
      const adapter = await createBoundedPgAdapter(raw, scope).connect()
      const pool = adapter.underlyingDriver()
      expect(pool.options).not.toHaveProperty("connectionString")
      expect(pool.options.ssl).toEqual({ rejectUnauthorized: true })
      expect(pool.options.host).toBe("aws-0-test.pooler.supabase.com")
      expect(pool.options.max).toBe(4)
      await adapter.dispose()
    }
  )

  it("observes the pg pool created by Prisma without opening a database connection", async () => {
    const adapter = await createBoundedPgAdapter("postgresql://u:p@127.0.0.1:5432/db").connect()
    const pool = adapter.underlyingDriver()

    expect(pool.connect).not.toBe(pg.Pool.prototype.connect)
    await adapter.dispose()
  })
})

describe("observePgPoolConnections", () => {
  it("logs connect attempts with current low-cardinality pool counts", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {})
    const connect = (() => Promise.resolve({} as pg.PoolClient)) as pg.Pool["connect"]
    const pool = createTestPool(connect)

    observePgPoolConnections(pool, "db")
    await pool.connect()

    expect(debug).toHaveBeenCalledWith(
      "Database pool connection attempt",
      expect.objectContaining({
        scope: "db",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
      })
    )
    expect(debug).toHaveBeenCalledWith(
      "Database pool connection acquired",
      expect.objectContaining({
        scope: "db",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
      })
    )
  })

  it("logs failed connects without logging error text or connection details", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {})
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const error = Object.assign(
      new Error("connect timeout: postgresql://user:password@db.example/private"),
      { code: "ETIMEDOUT" }
    )
    const connect = (() => Promise.reject(error)) as pg.Pool["connect"]
    const pool = createTestPool(connect)

    observePgPoolConnections(pool, "db:system")
    await expect(pool.connect()).rejects.toBe(error)

    expect(debug).toHaveBeenCalledWith(
      "Database pool connection attempt",
      expect.objectContaining({
        scope: "db:system",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
      })
    )
    expect(warn).toHaveBeenCalledWith(
      "Database pool connection failed",
      expect.objectContaining({
        scope: "db:system",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
        code: "ETIMEDOUT",
      })
    )
    const failureMetadata = warn.mock.calls[0]?.[1]
    expect(failureMetadata).not.toHaveProperty("name")
    expect(failureMetadata).not.toHaveProperty("message")
    expect(failureMetadata).not.toHaveProperty("stack")
    expect(JSON.stringify([...debug.mock.calls, ...warn.mock.calls])).not.toContain("db.example")
    expect(JSON.stringify([...debug.mock.calls, ...warn.mock.calls])).not.toContain("password")
    expect(JSON.stringify([...debug.mock.calls, ...warn.mock.calls])).not.toContain("postgresql://")
    expect(JSON.stringify([...debug.mock.calls, ...warn.mock.calls])).not.toContain(
      "connect timeout"
    )
  })

  it("logs callback-based pg connection failures without changing the callback result", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const error = Object.assign(
      new Error("connect timeout: postgresql://user:password@db.example/private"),
      { code: "ETIMEDOUT postgresql://user:password@db.example/private" }
    )
    const connect = ((callback?: Parameters<pg.Pool["connect"]>[0]) => {
      if (callback) {
        callback(error, undefined, () => {})
        return
      }
      return Promise.reject(error)
    }) as pg.Pool["connect"]
    const pool = createTestPool(connect)

    observePgPoolConnections(pool, "db")
    await new Promise<void>((resolve) => {
      pool.connect((callbackError) => {
        expect(callbackError).toBe(error)
        resolve()
      })
    })

    expect(warn).toHaveBeenCalledWith(
      "Database pool connection failed",
      expect.objectContaining({
        scope: "db",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
      })
    )
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("code")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("db.example")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("password")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgresql://")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("connect timeout")
  })

  it("preserves pg Pool callback connect behavior", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {})
    const connect = ((callback?: Parameters<pg.Pool["connect"]>[0]) => {
      if (callback) {
        callback(undefined, {} as pg.PoolClient, () => {})
        return
      }
      return Promise.resolve({} as pg.PoolClient)
    }) as pg.Pool["connect"]
    const pool = createTestPool(connect)

    observePgPoolConnections(pool, "db")
    await new Promise<void>((resolve, reject) => {
      pool.connect((error) => (error ? reject(error) : resolve()))
    })

    expect(debug).toHaveBeenCalledWith(
      "Database pool connection acquired",
      expect.objectContaining({
        scope: "db",
        totalCount: 3,
        idleCount: 1,
        waitingCount: 2,
        durationMs: expect.any(Number),
      })
    )
  })
})
