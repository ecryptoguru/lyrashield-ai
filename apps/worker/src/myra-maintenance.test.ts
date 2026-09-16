import { beforeEach, describe, expect, it, vi } from "vitest"

const { pruneMyraRetention, recoverMyraState, logger } = vi.hoisted(() => ({
  pruneMyraRetention: vi.fn(),
  recoverMyraState: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}))

vi.mock("@lyrashield/myra/server", () => ({ pruneMyraRetention, recoverMyraState }))
vi.mock("@lyrashield/logger", () => ({ logger }))

import {
  runMyraMaintenance,
  runMyraRecovery,
  startMyraMaintenanceRunner,
  startMyraRecoveryRunner,
} from "./myra-maintenance"

const FIVE_MINUTES_MS = 5 * 60 * 1000
const THIRTY_MINUTES_MS = 30 * 60 * 1000

const zeroCounts = {
  conversations: 0,
  publicSessions: 0,
  verifications: 0,
  supportCases: 0,
  demoBookings: 0,
  operations: 0,
  generationReservations: 0,
  rescheduledOriginals: 0,
}

describe("Myra maintenance runners", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pruneMyraRetention.mockResolvedValue({ ...zeroCounts })
    recoverMyraState.mockResolvedValue({ wedgedOperations: 0, heldBookings: 0 })
  })

  it("runs state recovery immediately and then every five minutes", async () => {
    vi.useFakeTimers()
    try {
      const timer = startMyraRecoveryRunner()
      await vi.advanceTimersByTimeAsync(0)
      expect(recoverMyraState).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS * 2)
      expect(recoverMyraState).toHaveBeenCalledTimes(3)
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it("runs retention pruning immediately and then every thirty minutes", async () => {
    vi.useFakeTimers()
    try {
      const timer = startMyraMaintenanceRunner()
      await vi.advanceTimersByTimeAsync(0)
      expect(pruneMyraRetention).toHaveBeenCalledTimes(1)
      // A five-minute wait must not trigger another prune.
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS)
      expect(pruneMyraRetention).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(THIRTY_MINUTES_MS - FIVE_MINUTES_MS)
      expect(pruneMyraRetention).toHaveBeenCalledTimes(2)
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a rejected prune instead of propagating into the timer", async () => {
    vi.useFakeTimers()
    try {
      pruneMyraRetention.mockRejectedValue(new Error("sweep exploded"))
      const timer = startMyraMaintenanceRunner()
      await vi.advanceTimersByTimeAsync(0)
      expect(logger.error).toHaveBeenCalledWith("Myra maintenance sweep failed", {
        error: "sweep exploded",
      })
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports pruned rows without exposing record content", async () => {
    pruneMyraRetention.mockResolvedValue({
      ...zeroCounts,
      conversations: 1,
      publicSessions: 2,
      verifications: 3,
      demoBookings: 1,
      operations: 1,
      generationReservations: 1,
      rescheduledOriginals: 2,
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
      rescheduledOriginals: 2,
    })
  })

  it("reports recovered wedged state without exposing record content", async () => {
    recoverMyraState.mockResolvedValue({ wedgedOperations: 1, heldBookings: 2 })
    await runMyraRecovery()
    expect(logger.info).toHaveBeenCalledWith("Myra recovery sweep completed", {
      wedgedOperations: 1,
      heldBookings: 2,
    })
  })
})
