import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ping: vi.fn(),
  evidence: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({ prisma: { $queryRaw: mocks.query } }))
vi.mock("@lyrashield/evidence-storage", () => ({
  assertEvidenceStorageConfigured: mocks.evidence,
}))
vi.mock("@lyrashield/integrations", () => ({ getRedis: () => ({ ping: mocks.ping }) }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue([{ "?column?": 1 }])
    mocks.ping.mockResolvedValue("PONG")
  })

  it("reports database, Redis, and local evidence configuration ready", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { database: true, redis: true, evidence: true },
    })
  })

  it("fails readiness when evidence configuration is invalid without another Redis command", async () => {
    mocks.evidence.mockImplementationOnce(() => {
      throw new Error("invalid evidence configuration")
    })

    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ checks: { evidence: false } })
    expect(mocks.ping).toHaveBeenCalledTimes(1)
  })
})
