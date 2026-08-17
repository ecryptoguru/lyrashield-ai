import { describe, expect, it } from "vitest"
import { createBoundedPgAdapter, resolveDbPoolMax } from "./pool"

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
  it("builds an adapter without throwing for a valid connection string", () => {
    // The adapter wraps a pg.Pool built from the config; it does not connect
    // until first use, so construction alone must succeed.
    expect(() => createBoundedPgAdapter("postgresql://u:p@127.0.0.1:5432/db")).not.toThrow()
  })
})
