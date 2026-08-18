import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  redis: { llen: vi.fn() },
}))

vi.mock("@lyrashield/integrations", () => ({ getRedis: () => mocks.redis }))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import {
  checkScanConsumerLiveness,
  markScanJobClaimed,
  resetScanConsumerLiveness
} from "./consumer-liveness"

describe("scan consumer liveness guard", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("does not trip on an idle queue (nothing waiting) after a long idle period", async () => {
    mocks.redis.llen.mockResolvedValue(0)
    // A far-future "now" must not wedge an empty queue.
    const farFuture = Date.now() + 60 * 60_000
    const result = await checkScanConsumerLiveness(farFuture)
    expect(result).not.toBeNull()
    expect(result!.waiting).toBe(0)
    expect(result!.wedged).toBe(false)
  })

  it("does not trip when a job was claimed recently even if work is waiting", async () => {
    mocks.redis.llen.mockResolvedValue(1)
    resetScanConsumerLiveness(1_000_000)
    markScanJobClaimed(1_000_000)
    // Check 5s after the claim — well within the block window.
    const result = await checkScanConsumerLiveness(1_005_000)
    expect(result!.waiting).toBe(1)
    expect(result!.wedged).toBe(false)
  })

  it("trips when jobs are waiting but the consumer is idle past block window + grace", async () => {
    mocks.redis.llen.mockResolvedValue(2)
    resetScanConsumerLiveness(0)
    // 600s block + 120s grace => wedge beyond 720s idle with waiting work.
    const result = await checkScanConsumerLiveness(721_000)
    expect(result!.waiting).toBe(2)
    expect(result!.wedged).toBe(true)
  })

  it("resets the idle clock on each new claim", async () => {
    mocks.redis.llen.mockResolvedValue(1)
    resetScanConsumerLiveness(0)
    // Advance past the wedge threshold, then claim — the clock must reset.
    markScanJobClaimed(800_000)
    const result = await checkScanConsumerLiveness(805_000)
    expect(result!.wedged).toBe(false)
  })

  it("returns null (no signal) when the liveness read fails", async () => {
    mocks.redis.llen.mockRejectedValue(new Error("Connection is closed"))
    const result = await checkScanConsumerLiveness()
    expect(result).toBeNull()
  })
})
