import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/integrations", () => ({
  assertScanWorkerAvailable: vi.fn(),
  ScanWorkerUnavailableError: class ScanWorkerUnavailableError extends Error {},
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { warn: vi.fn() } }))

import { assertScanWorkerAvailable, ScanWorkerUnavailableError } from "@lyrashield/integrations"
import { GET } from "./route"

describe("GET /api/ready/scans", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports ready only when worker and admission checks both pass", async () => {
    vi.mocked(assertScanWorkerAvailable)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ScanWorkerUnavailableError())

    expect((await GET()).status).toBe(200)
    expect((await GET()).status).toBe(503)
  })
})
