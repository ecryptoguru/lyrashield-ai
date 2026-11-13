import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ping: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: { $queryRaw: mocks.query },
  SCAN_ACCOUNTING_PROTOCOL: "reservations/2",
}))
vi.mock("@lyrashield/integrations", () => ({ getRedis: () => ({ ping: mocks.ping }) }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

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
    expect(response.headers.get("X-LyraShield-Accounting-Protocol")).toBe("reservations/2")
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { database: true, redis: true },
    })
  })
})
