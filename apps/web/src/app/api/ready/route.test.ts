import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ping: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({ prisma: { $queryRaw: mocks.query } }))
vi.mock("@lyrashield/integrations", () => ({ getRedis: () => ({ ping: mocks.ping }) }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue([{ "?column?": 1 }])
    mocks.ping.mockResolvedValue("PONG")
  })

  it("reports database and Redis ready", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { database: true, redis: true },
    })
  })
})
