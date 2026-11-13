import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({
    $queryRaw: async () => {
      const scan = await mocks.findFirst()
      return scan ? [scan] : []
    },
  }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: mocks.logger }))

import { sampleTerminalCostHealth, startTerminalCostHealthSampler } from "./terminal-cost-health"

const scan = { id: "caaaaaaaaaaaaaaaaaaaaaaaa", endedAt: new Date("2026-09-23T12:57:32Z") }

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"))
  mocks.findFirst.mockResolvedValue(scan)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("terminal cost health sampling", () => {
  it("observes a persistent incident every five minutes while queue reconciliation is idle", async () => {
    const timer = startTerminalCostHealthSampler()
    await vi.advanceTimersByTimeAsync(65 * 60_000)
    clearInterval(timer)
    expect(mocks.logger.warn.mock.calls).toHaveLength(14)
    for (const [message, observation] of mocks.logger.warn.mock.calls) {
      expect(message).toBe("operational_health_sample")
      expect(observation).toMatchObject({
        code: "terminal_cost_unreconciled",
        state: "unhealthy",
        scanId: scan.id,
      })
      expect(observation.ageMs).toBeGreaterThan(900_000)
    }
  })

  it("records explicit recovery only after a successful empty read", async () => {
    expect(await sampleTerminalCostHealth()).toMatchObject({ state: "unhealthy", scanId: scan.id })
    mocks.findFirst.mockResolvedValue(null)
    expect(await sampleTerminalCostHealth()).toEqual({
      code: "terminal_cost_unreconciled",
      state: "healthy",
      observedAt: "2026-10-12T12:00:00.000Z",
    })
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "operational_health_sample",
      expect.objectContaining({ state: "healthy" })
    )
  })

  it("reports unknown without leaking a database error or reporting recovery", async () => {
    mocks.findFirst.mockRejectedValue(new Error("postgres://secret@customer.invalid/target"))
    expect(await sampleTerminalCostHealth()).toEqual({
      code: "terminal_cost_unreconciled",
      state: "unknown",
      observedAt: "2026-10-12T12:00:00.000Z",
    })
    expect(mocks.logger.info).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain("customer")
  })

  it("does not overlap slow reads or fabricate samples while one is pending", async () => {
    let resolve!: (value: typeof scan) => void
    mocks.findFirst.mockReturnValue(
      new Promise<typeof scan>((done) => {
        resolve = done
      })
    )
    const timer = startTerminalCostHealthSampler()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(mocks.logger.warn).not.toHaveBeenCalled()
    resolve(scan)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })

  it("rejects an unsafe diagnostic ID without logging it", async () => {
    mocks.findFirst.mockResolvedValue({ ...scan, id: "https://customer.invalid/secret" })
    expect(await sampleTerminalCostHealth()).toMatchObject({ state: "unknown" })
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain("customer")
  })
})
