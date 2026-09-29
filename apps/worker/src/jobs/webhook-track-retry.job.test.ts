import { beforeEach, describe, expect, it, vi } from "vitest"
const retry = vi.hoisted(() => vi.fn())
const schedule = vi.hoisted(() => vi.fn())
const enqueue = vi.hoisted(() => vi.fn())
const findMany = vi.hoisted(() => vi.fn())
const updateMany = vi.hoisted(() => vi.fn())
const getJob = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/db", () => ({ prisma: { webhookEventTrack: { findMany, updateMany } } }))
vi.mock("@lyrashield/billing", () => ({
  WEBHOOK_TRACK_IDS: ["billing", "license", "affiliate"],
  WEBHOOK_TRACK_MAX_ATTEMPTS: 5,
  retryWebhookTrack: retry,
  getWebhookTrackRetrySchedule: schedule,
}))
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: enqueue,
  getWebhookTrackRetryQueue: () => ({ getJob }),
  webhookTrackRetryJobId: (data: { generation: number }) => `retry-g${data.generation}`,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
import { processWebhookTrackRetry, recoverDueWebhookTrackRetries } from "./webhook-track-retry.job"
const handlers = { dispatchAffiliate: vi.fn() }
function job(generation = 1, id = `retry-g${generation}`) {
  const fixture = { id, data: { webhookEventId: "evt", track: "license", generation } }
  return fixture as Parameters<typeof processWebhookTrackRetry>[0]
}
beforeEach(() => {
  vi.clearAllMocks()
  retry.mockResolvedValue("failed")
  schedule.mockResolvedValue({ generation: 2, nextAttemptAt: new Date(Date.now() + 60_000) })
  enqueue.mockResolvedValue("retry-g2")
  getJob.mockResolvedValue(undefined)
  updateMany.mockResolvedValue({ count: 1 })
})
describe("generation-bound retry", () => {
  it("represents the persisted next generation after failure", async () => {
    expect(await processWebhookTrackRetry(job(), handlers)).toEqual({
      outcome: "failed",
      retryRepresented: true,
    })
    expect(enqueue).toHaveBeenCalledWith(
      { webhookEventId: "evt", track: "license", generation: 2 },
      { delayMs: expect.any(Number) }
    )
    expect(retry).toHaveBeenCalledWith({
      webhookEventId: "evt",
      track: "license",
      generation: 1,
      handlers,
    })
  })
  it("drops mismatched identities before domain execution", async () => {
    expect((await processWebhookTrackRetry(job(1, "wrong"), handlers)).outcome).toBe("missing")
    expect(retry).not.toHaveBeenCalled()
  })
  it("terminal or busy outcomes never enqueue", async () => {
    for (const outcome of [
      "succeeded",
      "dead_letter",
      "busy",
      "skipped_succeeded",
      "skipped_dead_letter",
      "missing",
    ]) {
      retry.mockResolvedValue(outcome)
      expect((await processWebhookTrackRetry(job(), handlers)).retryRepresented).toBe(false)
    }
    expect(enqueue).not.toHaveBeenCalled()
  })
  it("handoff failure leaves recovery to durable due state", async () => {
    enqueue.mockRejectedValueOnce(new Error("redis down"))
    expect((await processWebhookTrackRetry(job(), handlers)).retryRepresented).toBe(false)
  })
  it("bounded maintenance advances retained terminal generations without changing attempts", async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { webhookEventId: "evt", track: "license", generation: 2, nextAttemptAt: new Date(0) },
      ])
    getJob.mockResolvedValue({ getState: async () => "completed" })
    expect(await recoverDueWebhookTrackRetries(10)).toEqual({
      examined: 1,
      represented: 1,
      ambiguous: 0,
    })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { generation: { increment: 1 } } })
    )
    expect(enqueue).toHaveBeenCalledWith({ webhookEventId: "evt", track: "license", generation: 3 })
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      take: 10,
      where: { nextAttemptAt: { lte: expect.any(Date) }, attempts: { lt: 5 } },
    })
  })
})
