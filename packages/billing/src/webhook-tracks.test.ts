import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    webhookEventTrack: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const issueLicenseMock = vi.fn().mockResolvedValue({ licenseId: "lic_1", alreadyIssued: false })
vi.mock("./license-fulfillment", () => ({
  issueLicenseForProviderOrder: (...args: unknown[]) => issueLicenseMock(...args),
  parseLocalProductIds: () => ({}),
}))

const processPolarEventMock = vi.fn().mockResolvedValue({})
const processRazorpayEventMock = vi.fn().mockResolvedValue({})
vi.mock("./providers/polar/adapter", () => ({
  processPolarEvent: (...args: unknown[]) => processPolarEventMock(...args),
}))
vi.mock("./providers/razorpay/adapter", () => ({
  processRazorpayEvent: (...args: unknown[]) => processRazorpayEventMock(...args),
}))
vi.mock("./providers/polar/webhooks", () => ({ isHandledPolarEvent: () => true }))
vi.mock("./providers/razorpay/webhooks", () => ({ isHandledRazorpayEvent: () => true }))

import {
  computeApplicableTracks,
  runApplicableTracks,
  retryWebhookTrack,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  type WebhookTrackHandlers,
} from "./webhook-tracks"
import { normalizeProviderEvent } from "./domain-events"
import { prisma } from "@lyrashield/db"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
const handlers: WebhookTrackHandlers = { dispatchAffiliate: vi.fn().mockResolvedValue(undefined) }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.webhookEventTrack.createMany.mockResolvedValue({ count: 0 })
  mockPrisma.webhookEventTrack.findMany.mockResolvedValue([])
  mockPrisma.webhookEventTrack.findUnique.mockResolvedValue(null)
  mockPrisma.webhookEventTrack.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.webhookEventTrack.count.mockResolvedValue(0)
  mockPrisma.webhookEvent.findUnique.mockResolvedValue(null)
  issueLicenseMock.mockReset().mockResolvedValue({ licenseId: "lic_1", alreadyIssued: false })
})

function polarLocalOrder(orderId: string) {
  const payload = {
    type: "order.paid",
    data: {
      id: orderId,
      productId: "individual_regular",
      customer_email: "buyer@example.com",
      seats: 1,
    },
  }
  return {
    event: normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: orderId,
      payload,
    }),
    payload,
  }
}

describe("computeApplicableTracks — applicability matrix", () => {
  it("billing always; license only for local productKind; affiliate for commission-relevant", () => {
    const local = polarLocalOrder("ord_A").event
    expect(computeApplicableTracks(local)).toEqual(["billing", "license", "affiliate"])

    const subscription = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "subscription.charged",
      deliveryId: "d1",
      payload: {
        event: "subscription.charged",
        created_at: 1,
        payload: { subscription: { entity: { id: "sub_X" } } },
      },
    })
    // Razorpay recurring charges were never commission-bearing and stay so.
    expect(computeApplicableTracks(subscription)).toEqual(["billing"])

    // Polar cloud subscription paid IS commission-relevant.
    const polarSub = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "d1b",
      payload: {
        type: "order.paid",
        data: { id: "ord_SUB", subscription_id: "sub_P1", amount: 4900 },
      },
    })
    expect(computeApplicableTracks(polarSub)).toEqual(["billing", "affiliate"])

    // Minute pack: paid shape but NO affiliate track and NO license track.
    const pack = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "d2",
      payload: {
        type: "order.paid",
        data: { id: "ord_P1", metadata: { packId: "pack_100" } },
      },
    })
    expect(pack.productKind).toBe("minute_pack")
    expect(computeApplicableTracks(pack)).toEqual(["billing"])

    // Lifecycle transitions: billing only.
    const lifecycle = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "subscription.cancelled",
      deliveryId: "d3",
      payload: {
        event: "subscription.cancelled",
        created_at: 1,
        payload: { subscription: { entity: { id: "sub_Y" } } },
      },
    })
    expect(computeApplicableTracks(lifecycle)).toEqual(["billing"])

    // Refund: billing + affiliate clawback, never license.
    const refund = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "refund.created",
      deliveryId: "d4",
      payload: {
        event: "refund.created",
        created_at: 1,
        payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1" } } },
      },
    })
    expect(computeApplicableTracks(refund)).toEqual(["billing", "affiliate"])
  })
})

describe("c) Razorpay Track B — first + recurring payments each mint a license", () => {
  async function runRazorpayPaid(rawType: string, entity: Record<string, unknown>) {
    const payload = { event: rawType, created_at: 1_755_000_000, payload: { payment: { entity } } }
    const event = normalizeProviderEvent({
      provider: "razorpay",
      eventType: rawType,
      deliveryId: `del_${rawType}`,
      payload,
    })
    await runApplicableTracks({
      webhookEventId: `evt_${rawType}`,
      event,
      rawPayload: payload,
      handlers,
    })
  }

  it("first purchase (payment.captured) mints", async () => {
    await runRazorpayPaid("payment.captured", {
      id: "pay_FIRST",
      order_id: "order_FIRST",
      customer_email: "buyer@example.com",
      notes: { productId: "individual_regular" },
    })

    expect(issueLicenseMock).toHaveBeenCalledTimes(1)
    expect(issueLicenseMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "razorpay", orderId: "order_FIRST" })
    )
  })

  it("recurring charge (subscription.charged carrying a Local SKU product) mints", async () => {
    await runRazorpayPaid("subscription.charged", {
      id: "pay_RECUR_2",
      customer_email: "buyer@example.com",
      notes: { productId: "team_subscription", seats: 3 },
    })

    expect(issueLicenseMock).toHaveBeenCalledTimes(1)
    expect(issueLicenseMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "razorpay", orderId: "pay_RECUR_2", seatCount: 3 })
    )
  })

  it("idempotent replay of the same order does not mint twice", async () => {
    issueLicenseMock.mockResolvedValue({ licenseId: "lic_dup", alreadyIssued: true })
    const entity = {
      id: "pay_DUP",
      order_id: "order_DUP",
      customer_email: "buyer@example.com",
      notes: { productId: "individual_regular" },
    }
    await runRazorpayPaid("payment.captured", entity)
    await runRazorpayPaid("payment.captured", entity)
    // Fulfillment itself is idempotent per orderId — called once per ingress
    // execution, but the second call reports alreadyIssued (no double mint).
    expect(issueLicenseMock).toHaveBeenCalledTimes(2)
    expect(issueLicenseMock.mock.results[1]!.value).resolves.toMatchObject({
      alreadyIssued: true,
    })
  })
})

describe("runApplicableTracks / retryWebhookTrack — durable state machine", () => {
  it("a) billing ok + license handler fails → failed track recorded, not all-succeeded", async () => {
    issueLicenseMock.mockRejectedValue(new Error("signing key unavailable"))
    mockPrisma.webhookEventTrack.count.mockResolvedValue(1) // unsatisfied track remains

    const { event, payload } = polarLocalOrder("ord_FAIL")
    const summary = await runApplicableTracks({
      webhookEventId: "evt_fail",
      event,
      rawPayload: payload,
      handlers,
    })

    expect(summary.allSucceeded).toBe(false)
    expect(summary.failures.map((f) => f.track)).toContain("license")
    expect(summary.succeeded).toBe(2) // billing + affiliate
    expect(mockPrisma.webhookEvent.updateMany).not.toHaveBeenCalled()
    // attempts incremented to 1, status failed, bounded error stored.
    const failCall = mockPrisma.webhookEventTrack.updateMany.mock.calls.find(
      (c: [{ data: { status?: string } }]) => c[0].data.status === "failed"
    )
    expect(failCall[0].data.attempts).toBe(1)
    expect(failCall[0].data.lastError).toBe("signing key unavailable")
  })

  it("already-succeeded tracks are skipped on reprocess", async () => {
    mockPrisma.webhookEventTrack.findMany.mockResolvedValue([
      { track: "billing", status: "succeeded", attempts: 1 },
      { track: "license", status: "succeeded", attempts: 1 },
      { track: "affiliate", status: "succeeded", attempts: 1 },
    ])
    mockPrisma.webhookEventTrack.count.mockResolvedValue(0)

    const { event, payload } = polarLocalOrder("ord_DONE")
    const summary = await runApplicableTracks({
      webhookEventId: "evt_done",
      event,
      rawPayload: payload,
      handlers,
    })

    expect(summary.attempted).toBe(0)
    expect(summary.allSucceeded).toBe(true)
    expect(processPolarEventMock).not.toHaveBeenCalled()
    expect(issueLicenseMock).not.toHaveBeenCalled()
  })

  it("h) retryWebhookTrack dead-letters at the attempt cap", async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      provider: "polar",
      externalId: "ord_DL",
      eventType: "order.paid",
      payload: polarLocalOrder("ord_DL").payload,
    })
    issueLicenseMock.mockRejectedValue(new Error("still failing"))

    // Row sits at attempts = MAX-1 with status failed.
    mockPrisma.webhookEventTrack.findUnique.mockResolvedValue({
      track: "license",
      status: "failed",
      attempts: WEBHOOK_TRACK_MAX_ATTEMPTS - 1,
    })

    const outcome = await retryWebhookTrack({
      webhookEventId: "evt_dl",
      track: "license",
      handlers,
    })

    expect(outcome).toBe("dead_letter")
    const dlCall = mockPrisma.webhookEventTrack.updateMany.mock.calls.find(
      (c: [{ data: { status?: string } }]) => c[0].data.status === "dead_letter"
    )
    expect(dlCall).toBeTruthy()
    expect(dlCall[0].data.attempts).toBe(WEBHOOK_TRACK_MAX_ATTEMPTS)
    expect(dlCall[0].data.lastError).toBe("still failing")
  })

  it("retry job skips terminal states without executing handlers", async () => {
    for (const [status, expected] of [
      ["succeeded", "skipped_succeeded"],
      ["dead_letter", "skipped_dead_letter"],
    ] as const) {
      vi.clearAllMocks()
      mockPrisma.webhookEvent.findUnique.mockResolvedValue({
        provider: "polar",
        externalId: "x",
        eventType: "order.paid",
        payload: {},
      })
      mockPrisma.webhookEventTrack.findUnique.mockResolvedValue({
        track: "license",
        status,
        attempts: 5,
      })

      const outcome = await retryWebhookTrack({
        webhookEventId: "evt_term",
        track: "license",
        handlers,
      })
      expect(outcome).toBe(expected)
      expect(issueLicenseMock).not.toHaveBeenCalled()
    }
  })

  it("retry job removes stale rows whose track no longer applies", async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      provider: "razorpay",
      externalId: "evt_na",
      eventType: "subscription.activated",
      payload: {
        event: "subscription.activated",
        created_at: 1,
        payload: { subscription: { entity: { id: "sub_NA" } } },
      },
    })
    mockPrisma.webhookEventTrack.findUnique.mockResolvedValue({
      track: "license",
      status: "pending",
      attempts: 0,
    })

    const outcome = await retryWebhookTrack({
      webhookEventId: "evt_na",
      track: "license",
      handlers,
    })

    expect(outcome).toBe("not_applicable")
    expect(mockPrisma.webhookEventTrack.delete).toHaveBeenCalled()
  })

  it("missing event or row → 'missing' outcome, no execution", async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(null)
    expect(await retryWebhookTrack({ webhookEventId: "gone", track: "billing", handlers })).toBe(
      "missing"
    )

    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      provider: "polar",
      externalId: "x",
      eventType: "order.paid",
      payload: {},
    })
    mockPrisma.webhookEventTrack.findUnique.mockResolvedValue(null)
    expect(
      await retryWebhookTrack({ webhookEventId: "evt_norow", track: "license", handlers })
    ).toBe("missing")
  })
})
