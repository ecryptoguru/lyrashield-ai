import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => prisma,
  runWithWorkspaceContext: (_workspace: unknown, fn: () => unknown) => fn(),
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ generation: 0, attempts: 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
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
vi.mock("./provider-catalog-validation", () => ({
  assertProviderCatalogEvent: vi.fn(),
}))

import {
  computeApplicableTracks,
  runApplicableTracks,
  retryWebhookTrack,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  claimWebhookTrack,
  markTrackFailed,
  markTrackSucceeded,
  type WebhookTrackHandlers,
} from "./webhook-tracks"
import { normalizeProviderEvent } from "./domain-events"
import { prisma } from "@lyrashield/db"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
const handlers: WebhookTrackHandlers = { dispatchAffiliate: vi.fn().mockResolvedValue(undefined) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.$queryRaw).mockResolvedValue([{ generation: 0, attempts: 1 }])
  vi.mocked(prisma.$executeRaw).mockResolvedValue(1)
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
    expect(computeApplicableTracks(subscription)).toEqual(["billing", "affiliate"])

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

    // Proven full refund: billing + affiliate clawback, never license.
    const refund = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "refund.created",
      deliveryId: "d4",
      payload: {
        event: "refund.created",
        created_at: 1,
        payload: {
          payment: {
            entity: {
              id: "pay_1",
              amount: 100,
              amount_refunded: 100,
              currency: "INR",
              refund_status: "full",
            },
          },
          refund: {
            entity: {
              id: "rfnd_1",
              payment_id: "pay_1",
              amount: 100,
              currency: "INR",
              status: "processed",
            },
          },
        },
      },
    })
    expect(computeApplicableTracks(refund)).toEqual(["billing", "affiliate"])

    expect(computeApplicableTracks({ ...refund, productKind: "minute_pack" })).toEqual(["billing"])

    const partialRefund = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "refund.created",
      deliveryId: "d5",
      payload: {
        event: "refund.created",
        payload: {
          payment: {
            entity: {
              id: "pay_2",
              amount: 100,
              amount_refunded: 25,
              currency: "INR",
              refund_status: "partial",
            },
          },
          refund: {
            entity: {
              id: "rfnd_2",
              payment_id: "pay_2",
              amount: 25,
              currency: "INR",
              status: "processed",
            },
          },
        },
      },
    })
    expect(computeApplicableTracks(partialRefund)).toEqual(["billing"])

    const chargeback = normalizeProviderEvent({
      provider: "polar",
      eventType: "chargeback.created",
      deliveryId: "d6",
      payload: {
        type: "chargeback.created",
        data: {
          id: "chargeback_1",
          order_id: "order_1",
          amount: 100,
          currency: "USD",
        },
      },
    })
    expect(computeApplicableTracks(chargeback)).toEqual(["billing", "affiliate"])
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
    issueLicenseMock
      .mockResolvedValueOnce({ licenseId: "lic_dup", alreadyIssued: false })
      .mockResolvedValueOnce({ licenseId: "lic_dup", alreadyIssued: true })
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
    await expect(issueLicenseMock.mock.results[0]!.value).resolves.toMatchObject({
      licenseId: "lic_dup",
      alreadyIssued: false,
    })
    await expect(issueLicenseMock.mock.results[1]!.value).resolves.toMatchObject({
      licenseId: "lic_dup",
      alreadyIssued: true,
    })
  })
})

describe("durable webhook claims", () => {
  it("reserves attempts before handler execution and fences a successful receipt", async () => {
    const { event, payload } = polarLocalOrder("ord_success")
    const summary = await runApplicableTracks({
      webhookEventId: "evt",
      event,
      rawPayload: payload,
      handlers,
    })
    expect(summary.succeeded).toBe(3)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3)
    expect(prisma.$executeRaw).toHaveBeenCalled()
    const claimSql = vi.mocked(prisma.$queryRaw).mock.calls[0]![0] as unknown as string[]
    expect(claimSql.join(" ")).toContain("attempts = attempts + 1")
  })

  it("busy and terminal claims never execute a handler", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([])
    mockPrisma.webhookEventTrack.findUnique.mockResolvedValue({ status: "processing" })
    const { event, payload } = polarLocalOrder("ord_busy")
    expect(
      (await runApplicableTracks({ webhookEventId: "evt", event, rawPayload: payload, handlers }))
        .attempted
    ).toBe(0)
    expect(issueLicenseMock).not.toHaveBeenCalled()
    mockPrisma.webhookEventTrack.findUnique.mockResolvedValue({ status: "succeeded" })
    expect(await claimWebhookTrack("evt", "billing")).toEqual({
      outcome: "terminal",
      status: "succeeded",
    })
  })

  it("fifth reservation dead-letters without extending the total budget", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { generation: 4, attempts: WEBHOOK_TRACK_MAX_ATTEMPTS },
    ])
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      provider: "polar",
      externalId: "ord",
      eventType: "order.paid",
      payload: polarLocalOrder("ord").payload,
      workspaceId: null,
    })
    issueLicenseMock.mockRejectedValue(new Error("still failing"))
    expect(
      await retryWebhookTrack({ webhookEventId: "evt", track: "license", generation: 4, handlers })
    ).toBe("dead_letter")
    const fail = vi.mocked(prisma.$executeRaw).mock.calls.at(-1)!
    expect(fail).toContain("dead_letter")
    expect(fail).toContain(true)
  })

  it("stale ownership cannot complete or downgrade a terminal receipt", async () => {
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0)
    const claim = {
      webhookEventId: "evt",
      track: "billing" as const,
      generation: 1,
      attempts: 2,
      token: "stale",
    }
    expect(await markTrackSucceeded(claim)).toBe(false)
    expect(await markTrackFailed(claim, new Error("late"))).toBe(false)
    for (const call of vi.mocked(prisma.$executeRaw).mock.calls) {
      const sql = (call[0] as unknown as string[]).join(" ")
      expect(sql).toContain("status = 'processing'")
      expect(sql).toContain('"leaseExpiresAt" > now()')
      expect(call).toContain("stale")
    }
  })
})
