import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/integrations", () => ({
  assertScanWorkerAvailable: vi.fn(),
  ScanWorkerUnavailableError: class ScanWorkerUnavailableError extends Error {
    constructor(readonly reason = "UNKNOWN") {
      super("No scan worker is currently available")
    }
  },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { warn: vi.fn() } }))

import { assertScanWorkerAvailable, ScanWorkerUnavailableError } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
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

  it.each([
    "ADMISSION_HELD",
    "NO_WORKER_LEASE",
    "REDIS_UNAVAILABLE",
    "PROVENANCE_INVALID",
    "UNKNOWN",
  ] as const)(
    "logs the internal %s reason without changing the public response",
    async (reason) => {
      vi.mocked(assertScanWorkerAvailable).mockRejectedValueOnce(
        new ScanWorkerUnavailableError(reason)
      )

      const response = await GET()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: "not_ready", checks: { worker: false } })
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(logger.warn).toHaveBeenCalledWith("Scan service readiness check failed", {
        ready: false,
        reason,
      })
    }
  )
})
