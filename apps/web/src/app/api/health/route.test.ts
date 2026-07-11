import { beforeEach, describe, expect, it, vi } from "vitest"

const queryRaw = vi.fn()
const ping = vi.fn()
const getRedis = vi.fn(() => ({ ping }))

vi.mock("@lyrashield/db", () => ({ prisma: { $queryRaw: queryRaw } }))
vi.mock("@lyrashield/integrations", () => ({ getRedis }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

const health = await import("./route")
const ready = await import("../ready/route")

describe("health behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRedis.mockReturnValue({ ping })
    queryRaw.mockResolvedValue([{ "?column?": 1 }])
    ping.mockResolvedValue("PONG")
  })

  it("reports process liveness", async () => {
    expect((await health.GET()).status).toBe(200)
  })

  it("reports ready only when database and Redis respond", async () => {
    expect((await ready.GET()).status).toBe(200)
    ping.mockRejectedValue(new Error("offline"))
    expect((await ready.GET()).status).toBe(503)
  })

  it("reports not ready when Redis is not configured", async () => {
    getRedis.mockReturnValueOnce(null as never)
    expect((await ready.GET()).status).toBe(503)
  })
})
