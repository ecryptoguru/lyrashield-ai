import { beforeEach, describe, expect, it, vi } from "vitest"

const runWithWorkspaceContextMock = vi.hoisted(() =>
  vi.fn((_workspaceId: string | null, fn: () => unknown) => fn())
)

vi.mock("@lyrashield/config", () => ({
  env: { NODE_ENV: "test", POLAR_LOCAL_PRODUCT_IDS: "", POLAR_WEBHOOK_TOLERANCE_MS: 300_000 },
  isDev: false,
  isProd: false,
}))

/**
 * Ingress unit tests — the durable track state machine itself is covered in
 * packages/billing/src/webhook-tracks.test.ts and the retry job in
 * apps/worker/src/jobs/webhook-track-retry.job.test.ts. Here the shared
 * executor (runApplicableTracks) is mocked so response-classification,
 * claim/arbitration, retry-enqueue, and replay semantics are isolated.
 */
vi.mock("@lyrashield/db", () => ({
  prisma: {
    webhookEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  runWithWorkspaceContext: runWithWorkspaceContextMock,
  // license-fulfillment (billing module graph) resolves the system client lazily
  getSystemPrisma: vi.fn(() => ({})),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const dispatchAffiliateMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@lyrashield/affiliate", () => ({
  dispatch: dispatchAffiliateMock,
}))
const enqueueRetryMock = vi.hoisted(() => vi.fn().mockResolvedValue("job_1"))
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: enqueueRetryMock,
}))

// Real billing module (validators + Razorpay identity derivation stay real);
// validators overridden per-test below, the track executor always mocked.
const validateRazorpayMock = vi.fn()
const validatePolarMock = vi.fn()
const assertCatalogMock = vi.fn()
const runTracksMock = vi.fn()
vi.mock("@lyrashield/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/billing")>()
  return {
    ...actual,
    validatePolarWebhook: (...args: unknown[]) => validatePolarMock(...args),
    validateRazorpayWebhook: (...args: unknown[]) => validateRazorpayMock(...args),
    assertProviderCatalogEvent: (...args: unknown[]) => assertCatalogMock(...args),
    runApplicableTracks: (...args: unknown[]) => runTracksMock(...args),
  }
})

import { prisma } from "@lyrashield/db"
import type { TrackRunSummary } from "@lyrashield/billing"
import { WebhookAuthError, WebhookPayloadError } from "@lyrashield/billing"
import { POST } from "./route"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>

/** All applicable tracks succeeded. */
function okSummary(): TrackRunSummary {
  return { allSucceeded: true, attempted: 0, succeeded: 0, failures: [], deadLettered: [] }
}

/** One required track failed (or dead-lettered). */
function failedSummary(track: string, opts: { deadLetter?: boolean } = {}): TrackRunSummary {
  const failure = { track, error: `${track}_handler_failed` }
  return {
    allSucceeded: false,
    attempted: 1,
    succeeded: 1,
    failures: opts.deadLetter ? [] : [failure],
    deadLettered: opts.deadLetter ? [failure] : [],
  }
}

/** Build a Razorpay-shaped signed request. */
function razorpayRequest(
  body: unknown,
  headers: Record<string, string> = { "x-razorpay-signature": "valid-sig" }
) {
  return new Request("http://localhost/billing/webhook", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  })
}

function rzEvent(event: string, subId: string, createdAt: number) {
  return {
    event,
    created_at: createdAt,
    payload: {
      subscription: {
        entity: { id: subId, status: "active", plan_id: "plan_1" },
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps per-mock implementations — strip leftovers from
  // earlier tests (e.g. a persisting mockRejectedValue) before re-priming.
  validateRazorpayMock.mockReset()
  validatePolarMock.mockReset()
  assertCatalogMock.mockReset().mockReturnValue(null)
  runTracksMock.mockReset().mockResolvedValue(okSummary())
  dispatchAffiliateMock.mockReset().mockResolvedValue(undefined)
  enqueueRetryMock.mockReset().mockResolvedValue("job_1")
  // Guard: no code path may fall back to random identity.
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    throw new Error("randomUUID must never be used for webhook identity")
  })
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "evt_row_1" })
  mockPrisma.webhookEvent.findUnique.mockResolvedValue(null)
  runWithWorkspaceContextMock.mockClear()
})

describe("POST /billing/webhook — event identity and idempotency", () => {
  it("rejects signed catalog mismatches before claiming a webhook row", async () => {
    const event = rzEvent("subscription.charged", "sub_UNDERPAID", 1_755_086_400)
    validateRazorpayMock.mockReturnValue(event)
    assertCatalogMock.mockImplementation(() => {
      throw new WebhookPayloadError("Provider catalog evidence mismatch")
    })

    const response = await POST(razorpayRequest(event))

    expect(response.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(runTracksMock).not.toHaveBeenCalled()
  })

  it("returns 500 for retryable provider-catalog configuration failures", async () => {
    const event = rzEvent("subscription.charged", "sub_CONFIG", 1_755_086_400)
    validateRazorpayMock.mockReturnValue(event)
    assertCatalogMock.mockImplementation(() => {
      throw new Error("RAZORPAY_PLAN_IDS is missing or malformed")
    })

    const response = await POST(razorpayRequest(event))

    expect(response.status).toBe(500)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(runTracksMock).not.toHaveBeenCalled()
  })

  it("a-pre) Razorpay lifecycle sharing one resource id yields three distinct identities, all processed", async () => {
    const events = [
      rzEvent("subscription.activated", "sub_LIFE", 1_755_000_000),
      rzEvent("subscription.charged", "sub_LIFE", 1_755_086_400),
      rzEvent("subscription.cancelled", "sub_LIFE", 1_755_172_800),
    ]
    for (const ev of events) {
      validateRazorpayMock.mockReturnValue(ev)
      const res = await POST(razorpayRequest(ev))
      expect(res.status).toBe(200)
    }
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(3)
    const ids = mockPrisma.webhookEvent.create.mock.calls.map(
      (c: [{ data: { externalId: string; identitySource: string } }]) => c[0].data.externalId
    )
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(
      mockPrisma.webhookEvent.create.mock.calls.every(
        (c: [{ data: { identitySource: string } }]) => c[0].data.identitySource === "derived"
      )
    ).toBe(true)
    expect(runTracksMock).toHaveBeenCalledTimes(3)
  })

  it("100 replays of a processed event answer 200 without reprocessing", async () => {
    const ev = rzEvent("subscription.charged", "sub_REPLAY", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)
    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_replay",
      processed: true,
      createdAt: new Date(Date.now() - 120_000),
    })

    for (let replay = 0; replay < 100; replay += 1) {
      const res = await POST(razorpayRequest(ev))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })
    }
    expect(runTracksMock).not.toHaveBeenCalled()
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("concurrent duplicate delivery processes exactly once, both answered 200", async () => {
    const ev = rzEvent("subscription.activated", "sub_RACE", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)

    // Simulate the DB unique constraint arbitrating two simultaneous inserts:
    // first create wins, second hits P2002 while the row is fresh/unprocessed.
    let calls = 0
    mockPrisma.webhookEvent.create.mockImplementation(async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error("unique"), { code: "P2002" })
      return { id: `evt_${calls}` }
    })
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_1",
      processed: false,
      createdAt: new Date(), // winner still in-flight
    })
    // Slow winner down so the loser's arbiter check lands mid-processing.
    runTracksMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return okSummary()
    })

    const [resA, resB] = await Promise.all([POST(razorpayRequest(ev)), POST(razorpayRequest(ev))])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(runTracksMock).toHaveBeenCalledTimes(1)
  })

  it("stranded (>60s) unprocessed row is reprocessed under its existing event id", async () => {
    const ev = rzEvent("subscription.charged", "sub_STALE", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)
    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_stranded",
      processed: false,
      createdAt: new Date(Date.now() - 120_000),
    })

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(200)
    expect(runTracksMock).toHaveBeenCalledTimes(1)
    expect(runTracksMock).toHaveBeenCalledWith(
      expect.objectContaining({ webhookEventId: "evt_stranded" })
    )
  })

  it("missing signature → 401, non-retryable class, no DB write", async () => {
    // Empty X-Razorpay-Signature still identifies the provider but fails auth.
    validateRazorpayMock.mockImplementation((_body: string, signature: string) => {
      if (!signature) {
        throw new WebhookAuthError("missing_signature", "Missing X-Razorpay-Signature header")
      }
    })

    const res = await POST(
      razorpayRequest(rzEvent("subscription.charged", "sub_NOSIG", 1), {
        "x-razorpay-signature": "",
      })
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe("WEBHOOK_UNAUTHORIZED")
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(dispatchAffiliateMock).not.toHaveBeenCalled()
  })

  it("unrecognized provider → 400, no validation attempted", async () => {
    const res = await POST(
      new Request("http://localhost/billing/webhook", { method: "POST", body: "{}" })
    )
    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
  })

  it("invalid signature → 401, non-retryable class, no DB write", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookAuthError("invalid_signature", "Invalid Razorpay webhook signature")
    })

    const res = await POST(razorpayRequest(rzEvent("subscription.charged", "sub_BADSIG", 1)))

    expect(res.status).toBe(401)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(runTracksMock).not.toHaveBeenCalled()
  })

  it("valid signature but malformed payload → 400, non-retryable", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookPayloadError("Razorpay webhook body is not valid JSON")
    })

    const res = await POST(razorpayRequest("{not-json"))

    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(dispatchAffiliateMock).not.toHaveBeenCalled()
  })

  it("stale-timestamp rejection is classified 400 non-retryable", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookAuthError("stale_timestamp", "outside tolerance")
    })

    const res = await POST(razorpayRequest(rzEvent("subscription.charged", "sub_OLD", 1)))

    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
  })

  it("derived-identity determinism: same inputs → same id; different type/timestamp/resource → different id", async () => {
    const { resolveRazorpayEventIdentity } = await import("@lyrashield/billing")

    const base = rzEvent("subscription.charged", "sub_DET", 1_755_000_000)
    const again = rzEvent("subscription.charged", "sub_DET", 1_755_000_000)
    const otherType = rzEvent("subscription.cancelled", "sub_DET", 1_755_000_000)
    const otherTime = rzEvent("subscription.charged", "sub_DET", 1_755_086_400)
    const otherResource = rzEvent("subscription.charged", "sub_OTHER", 1_755_000_000)

    const idOf = (e: ReturnType<typeof rzEvent>) =>
      resolveRazorpayEventIdentity(e, undefined)?.externalId

    expect(idOf(base)).toBe(idOf(again))
    expect(idOf(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(idOf(base)).not.toBe(idOf(otherType))
    expect(idOf(base)).not.toBe(idOf(otherTime))
    expect(idOf(base)).not.toBe(idOf(otherResource))

    // Header event id takes precedence over derivation.
    const viaHeader = resolveRazorpayEventIdentity(base, "evt_ABC123")
    expect(viaHeader).toEqual({ externalId: "evt_ABC123", identitySource: "delivery" })

    // No derivable inputs → null (never a random id).
    expect(
      resolveRazorpayEventIdentity(
        { event: "payout.created", created_at: 123, payload: {} as never },
        undefined
      )
    ).toBeNull()
  })

  it("Razorpay delivery-id header is persisted as identity source 'delivery'", async () => {
    const ev = rzEvent("subscription.charged", "sub_HDR", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)

    const res = await POST(
      razorpayRequest(ev, {
        "x-razorpay-signature": "valid-sig",
        "x-razorpay-event-id": "evt_DELIVERY_1",
      })
    )

    expect(res.status).toBe(200)
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "razorpay",
          externalId: "evt_DELIVERY_1",
          identitySource: "delivery",
        }),
      })
    )
  })

  it("persists a Polar delivery's normalized workspace binding", async () => {
    const workspaceId = "workspace_polar_receipt"
    const event = {
      type: "subscription.canceled",
      data: {
        id: "sub_POLAR_1",
        metadata: { workspaceId },
      },
    }
    validatePolarMock.mockReturnValue(event)

    const response = await POST(
      new Request("http://localhost/billing/webhook", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "webhook-id": "polar_delivery_1", "webhook-signature": "valid-sig" },
      })
    )

    expect(response.status).toBe(200)
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "polar",
          externalId: "polar_delivery_1",
          workspaceId,
        }),
      })
    )
  })

  it("repairs a legacy processed Polar delivery with its workspace binding", async () => {
    const workspaceId = "workspace_polar_receipt"
    const event = {
      type: "subscription.canceled",
      data: { id: "sub_POLAR_1", metadata: { workspaceId } },
    }
    validatePolarMock.mockReturnValue(event)
    mockPrisma.webhookEvent.create.mockRejectedValue({ code: "P2002" })
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_legacy_polar",
      workspaceId: null,
      processed: true,
      createdAt: new Date(0),
    })

    const response = await POST(
      new Request("http://localhost/billing/webhook", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "webhook-id": "polar_delivery_legacy", "webhook-signature": "valid-sig" },
      })
    )

    expect(response.status).toBe(200)
    expect(runWithWorkspaceContextMock).toHaveBeenCalledWith(workspaceId, expect.any(Function))
    expect(mockPrisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_legacy_polar", workspaceId: null },
      data: { workspaceId },
    })
  })
})

describe("POST /billing/webhook — required-track durability (findings 12/18A)", () => {
  /** A Razorpay Local SKU purchase payload (license + affiliate tracks apply). */
  function rzLocalPurchase() {
    const ev = {
      event: "payment.captured",
      created_at: 1_755_000_000,
      payload: {
        payment: {
          entity: {
            id: "pay_LOCAL_1",
            order_id: "order_LOCAL_1",
            customer_email: "buyer@example.com",
            notes: { productId: "individual_regular" },
          },
        },
      },
    }
    return ev
  }

  it("a) billing ok + license track failed → 5xx, failed track durably queued for retry", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockResolvedValue(failedSummary("license"))

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe("WEBHOOK_PROCESSING_FAILED")
    // Executor received the claimed event id + injected affiliate handler.
    expect(runTracksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookEventId: "evt_row_1",
        handlers: { dispatchAffiliate: dispatchAffiliateMock },
      })
    )
    // Exactly one bounded retry enqueued for the failed track.
    expect(enqueueRetryMock).toHaveBeenCalledTimes(1)
    expect(enqueueRetryMock).toHaveBeenCalledWith({
      webhookEventId: "evt_row_1",
      track: "license",
    })
  })

  it("a-post) redelivery after the retry job completed the track → 200 replay, zero side effects", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)

    // First delivery: license track fails → 5xx.
    runTracksMock.mockResolvedValueOnce(failedSummary("license"))
    expect((await POST(razorpayRequest(ev))).status).toBe(500)

    // Retry job completes the track durably; provider redelivers the same event.
    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_row_1",
      processed: true,
      createdAt: new Date(Date.now() - 120_000),
    })

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(200)
    // Executor ran exactly once across both deliveries (ingress attempt only).
    expect(runTracksMock).toHaveBeenCalledTimes(1)
    expect(enqueueRetryMock).toHaveBeenCalledTimes(1)
  })

  it("b) affiliate/clawback track failure → 5xx + one retry enqueue for the affiliate track", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockResolvedValue(failedSummary("affiliate"))

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(500)
    expect(enqueueRetryMock).toHaveBeenCalledTimes(1)
    expect(enqueueRetryMock).toHaveBeenCalledWith({
      webhookEventId: "evt_row_1",
      track: "affiliate",
    })
  })

  it("dead-lettered tracks are NOT re-enqueued at ingress", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockResolvedValue(failedSummary("license", { deadLetter: true }))

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(500)
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("g) duplicate delivery after full success → 200 with zero extra side effects", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)

    const first = await POST(razorpayRequest(ev))
    expect(first.status).toBe(200)

    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: "evt_row_1",
      processed: true,
      createdAt: new Date(),
    })

    const second = await POST(razorpayRequest(ev))

    expect(second.status).toBe(200)
    expect(runTracksMock).toHaveBeenCalledTimes(1)
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("i) retry-enqueue failure → 5xx and the event stays unprocessed (no silent swallow)", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockResolvedValue(failedSummary("license"))
    enqueueRetryMock.mockRejectedValue(new Error("redis unavailable"))

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(500)
    expect(enqueueRetryMock).toHaveBeenCalledTimes(1)
  })

  it("executor crash (DB down mid-run) → 5xx so the provider retries", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockRejectedValue(new Error("db connection lost"))

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(500)
    expect(enqueueRetryMock).not.toHaveBeenCalled()
  })

  it("full success answers 200 and hands every normalized field to the executor", async () => {
    const ev = rzLocalPurchase()
    validateRazorpayMock.mockReturnValue(ev)
    runTracksMock.mockResolvedValue(okSummary())

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(200)
    const call = runTracksMock.mock.calls[0][0] as {
      webhookEventId: string
      event: { kind: string; productKind: string; orderId: string | null }
      rawPayload: unknown
    }
    // Normalizer output flows through: local purchase shape detected.
    expect(call.event.kind).toBe("local_purchase_paid")
    expect(call.event.productKind).toBe("local")
    expect(call.event.orderId).toBe("order_LOCAL_1")
    expect(call.rawPayload).toEqual(ev)
  })
})
