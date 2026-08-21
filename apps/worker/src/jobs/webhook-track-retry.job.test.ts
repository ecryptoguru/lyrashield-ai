import { beforeEach, describe, expect, it, vi } from "vitest"

const retryWebhookTrackMock = vi.fn()
vi.mock("@lyrashield/billing", () => ({
  WEBHOOK_TRACK_IDS: ["billing", "license", "affiliate"],
  WEBHOOK_TRACK_MAX_ATTEMPTS: 5,
  retryWebhookTrack: (...args: unknown[]) => retryWebhookTrackMock(...args),
}))
const enqueueRetryMock = vi.fn().mockResolvedValue("job_1")
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: (...args: unknown[]) => enqueueRetryMock(...args),
  WEBHOOK_TRACK_RETRY_QUEUE_NAME: "webhook-track-retry",
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { processWebhookTrackRetry, WEBHOOK_TRACK_MAX_ATTEMPTS } from "./webhook-track-retry.job"

function job(data: Record<string, string>) {
  return { data } as Parameters<typeof processWebhookTrackRetry>[0]
}

const handlers = { dispatchAffiliate: vi.fn() }

beforeEach(() => {
  retryWebhookTrackMock.mockReset()
  enqueueRetryMock.mockClear().mockResolvedValue("job_1")
})

describe("processWebhookTrackRetry — bounded attempt budget", () => {
  it("h) failed under cap re-enqueues exactly one delayed next attempt", async () => {
    retryWebhookTrackMock.mockResolvedValue("failed")

    const result = await processWebhookTrackRetry(
      job({ webhookEventId: "evt_1", track: "license" }),
      handlers
    )

    expect(result.outcome).toBe("failed")
    expect(result.reEnqueued).toBe(true)
    expect(enqueueRetryMock).toHaveBeenCalledTimes(1)
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      { webhookEventId: "evt_1", track: "license" },
      { delayMs: expect.any(Number) }
    )
  })

  it("h) dead_letter outcome is terminal — never re-enqueued", async () => {
    retryWebhookTrackMock.mockResolvedValue("dead_letter")

    const result = await processWebhookTrackRetry(
      job({ webhookEventId: "evt_dl", track: "affiliate" }),
      handlers
    )

    expect(result.outcome).toBe("dead_letter")
    expect(result.reEnqueued).toBe(false)
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("terminal/terminal-adjacent outcomes never re-enqueue", async () => {
    for (const outcome of [
      "succeeded",
      "skipped_succeeded",
      "skipped_dead_letter",
      "not_applicable",
      "missing",
    ]) {
      retryWebhookTrackMock.mockResolvedValueOnce(outcome)
      const result = await processWebhookTrackRetry(
        job({ webhookEventId: `evt_${outcome}`, track: "billing" }),
        handlers
      )
      expect(result.outcome).toBe(outcome)
      expect(result.reEnqueued).toBe(false)
    }
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("unknown track in job data → dropped without execution", async () => {
    const result = await processWebhookTrackRetry(
      job({ webhookEventId: "evt_bad", track: "nope" }),
      handlers
    )
    expect(result.outcome).toBe("missing")
    expect(retryWebhookTrackMock).not.toHaveBeenCalled()
  })

  it("enqueue failure does not crash the job (reconciliation sweeps later)", async () => {
    retryWebhookTrackMock.mockResolvedValue("failed")
    enqueueRetryMock.mockRejectedValue(new Error("redis down"))

    const result = await processWebhookTrackRetry(
      job({ webhookEventId: "evt_eq", track: "billing" }),
      handlers
    )

    expect(result.outcome).toBe("failed")
    expect(result.reEnqueued).toBe(false)
  })
})

describe("attempt budget contract", () => {
  it("dead-letter cap is 5", () => {
    expect(WEBHOOK_TRACK_MAX_ATTEMPTS).toBe(5)
  })
})
