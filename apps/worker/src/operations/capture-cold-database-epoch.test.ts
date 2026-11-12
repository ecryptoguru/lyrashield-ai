import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  disconnect: vi.fn(),
  adapter: vi.fn(),
  construct: vi.fn(),
}))
vi.mock("@lyrashield/config", () => ({ env: { DATABASE_URL: "runtime-test-connection" } }))
vi.mock("@lyrashield/db", () => ({ createBoundedPgAdapter: mocks.adapter }))
vi.mock("@lyrashield/db/src/generated/prisma", () => ({
  PrismaClient: class {
    $queryRaw = mocks.query
    $disconnect = mocks.disconnect
    constructor(options: unknown) {
      mocks.construct(options)
    }
  },
}))
import { captureColdDatabaseEpoch } from "./capture-cold-database-epoch"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.adapter.mockReturnValue("runtime-adapter")
  mocks.query.mockResolvedValue([{ epoch: "1794480000.123456" }])
  mocks.disconnect.mockResolvedValue(undefined)
})

describe("trusted cold database epoch capture", () => {
  it("returns only the hash from the runtime connection and closes its silent client", async () => {
    expect(await captureColdDatabaseEpoch()).toBe(
      createHash("sha256").update("1794480000.123456").digest("hex")
    )
    expect(mocks.adapter).toHaveBeenCalledWith("runtime-test-connection")
    expect(mocks.construct).toHaveBeenCalledWith({ adapter: "runtime-adapter", log: [] })
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it("does not expose private details if closing the capture connection fails", async () => {
    mocks.disconnect.mockRejectedValueOnce(new Error("private connection details"))
    await expect(captureColdDatabaseEpoch()).rejects.toThrow(
      /^Cold database epoch capture unavailable$/
    )
  })

  it("disconnects and exposes only a generic error when the epoch query fails", async () => {
    mocks.query.mockRejectedValue(new Error("private connection details"))
    await expect(captureColdDatabaseEpoch()).rejects.toThrow(
      /^Cold database epoch capture unavailable$/
    )
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
})
