import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/integrations", () => ({ isScanWorkerAvailable: vi.fn() }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn() } }))

import { isScanWorkerAvailable } from "@lyrashield/integrations"
import { GET } from "./route"

describe("GET /api/ready/scans", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports the scan service ready only with a live worker", async () => {
    vi.mocked(isScanWorkerAvailable).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    expect((await GET()).status).toBe(200)
    expect((await GET()).status).toBe(503)
  })
})
