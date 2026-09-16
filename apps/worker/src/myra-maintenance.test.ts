import { beforeEach, describe, expect, it, vi } from "vitest"

const { pruneMyraRetention, logger } = vi.hoisted(() => ({
  pruneMyraRetention: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}))

vi.mock("@lyrashield/myra/server", () => ({ pruneMyraRetention }))
vi.mock("@lyrashield/logger", () => ({ logger }))

import { runMyraMaintenance, startMyraMaintenanceRunner } from "./myra-maintenance"

describe("Myra maintenance runner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pruneMyraRetention.mockResolvedValue({
      conversations: 0,
      publicSessions: 0,
      verifications: 0,
      supportCases: 0,
      demoBookings: 0,
      operations: 0,
      generationReservations: 0,
    })
  })

  it("runs recovery immediately when the worker starts", async () => {
    vi.useFakeTimers()
    const timer = startMyraMaintenanceRunner(60_000)
    await vi.runAllTicks()
    expect(pruneMyraRetention).toHaveBeenCalledTimes(1)
    clearInterval(timer)
    vi.useRealTimers()
  })

  it("reports recovered rows without exposing record content", async () => {
    pruneMyraRetention.mockResolvedValue({
      conversations: 1,
      publicSessions: 2,
      verifications: 3,
      supportCases: 0,
      demoBookings: 1,
      operations: 1,
      generationReservations: 1,
    })
    await runMyraMaintenance()
    expect(logger.info).toHaveBeenCalledWith("Myra maintenance sweep completed", {
      conversations: 1,
      publicSessions: 2,
      verifications: 3,
      supportCases: 0,
      demoBookings: 1,
      operations: 1,
      generationReservations: 1,
    })
  })
})
