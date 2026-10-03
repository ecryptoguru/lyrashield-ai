import { beforeEach, describe, expect, it, vi } from "vitest"
const retry = vi.hoisted(() => vi.fn())
const schedule = vi.hoisted(() => vi.fn())
const enqueue = vi.hoisted(() => vi.fn())
const findMany = vi.hoisted(() => vi.fn())
const updateMany = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())
const executeRaw = vi.hoisted(() => vi.fn())
const normalizeProviderEvent = vi.hoisted(() => vi.fn())
const replaySafe = vi.hoisted(() => vi.fn())
const findEvent = vi.hoisted(() => vi.fn())
const getJob = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({ webhookEvent: { findUnique: findEvent } }),
  prisma: {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    webhookEventTrack: { findMany, updateMany },
  },
}))
vi.mock("@lyrashield/billing", () => ({
  WEBHOOK_TRACK_IDS: ["billing", "license", "affiliate"],
  WEBHOOK_TRACK_MAX_ATTEMPTS: 5,
  retryWebhookTrack: retry,
  getWebhookTrackRetrySchedule: schedule,
  normalizeProviderEvent,
  isExpiredWebhookTrackReplaySafe: replaySafe,
}))
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: enqueue,
  getWebhookTrackRetryQueue: () => ({ getJob }),
  webhookTrackRetryJobId: (data: { generation: number }) => `retry-g${data.generation}`,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
import { processWebhookTrackRetry, recoverDueWebhookTrackRetries } from "./webhook-track-retry.job"
const handlers = { dispatchAffiliate: vi.fn() }
function job(generation = 1, id = `retry-g${generation}`) {
  const fixture = { id, data: { webhookEventId: "evt", track: "license", generation } }
  return fixture as Parameters<typeof processWebhookTrackRetry>[0]
}
beforeEach(() => {
  vi.clearAllMocks()
  retry.mockResolvedValue("failed")
  schedule.mockResolvedValue({ generation: 2, delayMs: 60_000 })
  enqueue.mockResolvedValue("retry-g2")
  getJob.mockResolvedValue(undefined)
  updateMany.mockResolvedValue({ count: 1 })
  queryRaw.mockResolvedValue([])
  executeRaw.mockResolvedValue(1)
  normalizeProviderEvent.mockReturnValue({
    kind: "local_purchase_paid",
    productKind: "minute_pack",
  })
  replaySafe.mockReset().mockReturnValue(false)
  findEvent.mockResolvedValue({
    provider: "polar",
    externalId: "order_pack",
    eventType: "order.paid",
    payload: { type: "order.paid" },
  })
})
describe("generation-bound retry", () => {
  it("represents the persisted next generation after failure", async () => {
    expect(await processWebhookTrackRetry(job(), handlers)).toEqual({
      outcome: "failed",
      retryRepresented: true,
    })
    expect(enqueue).toHaveBeenCalledWith(
      { webhookEventId: "evt", track: "license", generation: 2 },
      { delayMs: 60_000 }
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
    queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ webhookEventId: "evt", track: "license", generation: 2 }])
    getJob.mockResolvedValue({ getState: async () => "completed" })
    expect(await recoverDueWebhookTrackRetries(10)).toEqual({
      examined: 1,
      represented: 1,
      ambiguous: 0,
    })
    expect(executeRaw).toHaveBeenCalledWith(expect.anything(), "evt", "license", 2)
    expect(enqueue).toHaveBeenCalledWith({ webhookEventId: "evt", track: "license", generation: 3 })
    const dueSql = (queryRaw.mock.calls[1]![0] as unknown as string[]).join(" ")
    expect(dueSql).toContain('"nextAttemptAtUtc" <= now()')
    expect(dueSql).toContain("attempts <")
  })

  it("reclaims an expired minute-pack billing claim with a new generation", async () => {
    replaySafe.mockReturnValue(true)
    queryRaw
      .mockResolvedValueOnce([
        {
          id: "track_1",
          webhookEventId: "evt_pack",
          track: "billing",
          generation: 0,
          attempts: 1,
          claimToken: "expired-token",
        },
      ])
      .mockResolvedValueOnce([{ webhookEventId: "evt_pack", track: "billing", generation: 1 }])

    await expect(recoverDueWebhookTrackRetries(10)).resolves.toEqual({
      examined: 1,
      represented: 1,
      ambiguous: 0,
    })
    expect(normalizeProviderEvent).toHaveBeenCalledWith({
      provider: "polar",
      eventType: "order.paid",
      payload: { type: "order.paid" },
      deliveryId: "order_pack",
    })
    expect(replaySafe).toHaveBeenCalledWith("billing", expect.any(Object))
    const reclaimSql = (executeRaw.mock.calls[0]![0] as unknown as string[]).join(" ")
    expect(reclaimSql).toContain("status = 'failed'")
    expect(reclaimSql).toContain("generation = generation + 1")
    expect(reclaimSql).toContain('"nextAttemptAtUtc" = now()')
    expect(enqueue).toHaveBeenCalledWith({
      webhookEventId: "evt_pack",
      track: "billing",
      generation: 1,
    })
  })

  it("leaves an expired claim untouched when its parent receipt cannot be read", async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: "track_1",
        webhookEventId: "evt_pack",
        track: "billing",
        generation: 0,
        attempts: 1,
        claimToken: "expired-token",
      },
    ])
    findEvent.mockRejectedValueOnce(new Error("database unavailable"))

    await expect(recoverDueWebhookTrackRetries(10)).rejects.toThrow("database unavailable")
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it("sends an idempotent expired claim at the attempt limit to receipt review", async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: "track_1",
        webhookEventId: "evt_pack",
        track: "billing",
        generation: 4,
        attempts: 5,
        claimToken: "expired-token",
      },
    ])
    replaySafe.mockReturnValue(true)

    await expect(recoverDueWebhookTrackRetries(10)).resolves.toMatchObject({ ambiguous: 1 })
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect((executeRaw.mock.calls[0]![0] as unknown as string[]).join(" ")).toContain(
      "status = 'dead_letter'"
    )
    expect(enqueue).not.toHaveBeenCalled()
  })
})
