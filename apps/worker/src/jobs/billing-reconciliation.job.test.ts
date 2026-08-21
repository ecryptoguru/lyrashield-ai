import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the billing module
vi.mock("@lyrashield/billing", () => ({
  getPolarClient: vi.fn(() => null),
  getRazorpayClient: vi.fn(() => null),
  WEBHOOK_TRACK_MAX_ATTEMPTS: 5,
}))

// Mock the retry-queue enqueue (queue authority lives in @lyrashield/integrations)
const enqueueWebhookTrackRetryMock = vi.fn().mockResolvedValue("job_1")
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: (...args: unknown[]) => enqueueWebhookTrackRetryMock(...args),
}))

// Mock prisma
vi.mock("@lyrashield/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(() => Promise.resolve([])),
    },
    webhookEventTrack: {
      findMany: vi.fn(() => Promise.resolve([])),
      count: vi.fn(() => Promise.resolve(0)),
    },
  },
}))

// Mock logger
vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { runBillingReconciliation } from "./billing-reconciliation.job"

describe("billing-reconciliation.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enqueueWebhookTrackRetryMock.mockResolvedValue("job_1")
  })

  it("returns a result with zero counts when no providers are configured", async () => {
    const result = await runBillingReconciliation()

    expect(result).toBeDefined()
    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
    expect(result.replayed).toBe(0)
    expect(result.driftAlerts).toBe(0)
    expect(result.tracksReEnqueued).toBe(0)
    expect(result.deadLetterSkipped).toBe(0)
    expect(result.alerts).toEqual([])
    expect(enqueueWebhookTrackRetryMock).not.toHaveBeenCalled()
  })

  it("h) re-enqueues failed-under-cap and stranded-pending tracks; skips dead letters", async () => {
    const { prisma } = await import("@lyrashield/db")
    const trackPrisma = (
      prisma as unknown as {
        webhookEventTrack: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
      }
    ).webhookEventTrack
    trackPrisma.findMany.mockResolvedValue([
      { id: "t1", webhookEventId: "evt_1", track: "license" },
      { id: "t2", webhookEventId: "evt_2", track: "affiliate" },
      { id: "t3", webhookEventId: "evt_3", track: "billing" },
    ])
    enqueueWebhookTrackRetryMock.mockRejectedValueOnce(new Error("redis down"))
    trackPrisma.count.mockResolvedValue(4)

    const result = await runBillingReconciliation()

    // t1 enqueue failed, t2 + t3 succeeded → 2 re-enqueued.
    expect(result.tracksReEnqueued).toBe(2)
    expect(result.deadLetterSkipped).toBe(4)
    // Dead letters are never enqueued — only the incomplete batch is.
    expect(enqueueWebhookTrackRetryMock).toHaveBeenCalledTimes(3)
    expect(enqueueWebhookTrackRetryMock).toHaveBeenCalledWith({
      webhookEventId: "evt_1",
      track: "license",
    })
  })

  it("completes without throwing when providers are unavailable", async () => {
    // The mocks return null for both clients, so reconciliation should
    // gracefully skip both providers and only check unprocessed events.
    const result = await runBillingReconciliation()

    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
  })
})
