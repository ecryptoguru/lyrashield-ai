import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    webhookEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const dispatchAffiliateMock = vi.fn().mockResolvedValue(undefined)
vi.mock("@lyrashield/affiliate", () => ({
  dispatch: (...args: unknown[]) => dispatchAffiliateMock(...args),
}))
vi.mock("@lyrashield/config", () => ({
  env: {},
}))
vi.mock("@lyrashield/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/pricing")>()),
  LOCAL_SKU_MAP: {},
}))
vi.mock("@/lib/licenses/license-service", () => ({
  issueLicenseForPolarOrder: vi.fn(),
}))
// Real billing module (for resolveRazorpayEventIdentity determinism tests),
// with validators/adapters overridden per-test below.
const validateRazorpayMock = vi.fn()
const processPolarEventMock = vi.fn().mockResolvedValue({})
const processRazorpayEventMock = vi.fn().mockResolvedValue({})
vi.mock("@lyrashield/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/billing")>()
  return {
    ...actual,
    validatePolarWebhook: vi.fn(),
    validateRazorpayWebhook: (...args: unknown[]) => validateRazorpayMock(...args),
    processPolarEvent: (...args: unknown[]) => processPolarEventMock(...args),
    processRazorpayEvent: (...args: unknown[]) => processRazorpayEventMock(...args),
    isHandledPolarEvent: actual.isHandledPolarEvent,
    isHandledRazorpayEvent: actual.isHandledRazorpayEvent,
    resolveProviderKey: vi.fn(() => null),
    resolveRazorpayEventIdentity: actual.resolveRazorpayEventIdentity,
    WebhookAuthError: actual.WebhookAuthError,
    WebhookPayloadError: actual.WebhookPayloadError,
  }
})

import { prisma } from "@lyrashield/db"
import { WebhookAuthError, WebhookPayloadError } from "@lyrashield/billing"
import { POST } from "./route"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>

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
  processPolarEventMock.mockReset().mockResolvedValue({})
  processRazorpayEventMock.mockReset().mockResolvedValue({})
  dispatchAffiliateMock.mockReset().mockResolvedValue(undefined)
  // Guard: no code path may fall back to random identity.
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    throw new Error("randomUUID must never be used for webhook identity")
  })
  mockPrisma.webhookEvent.create.mockResolvedValue({})
  mockPrisma.webhookEvent.findUnique.mockResolvedValue(null)
  mockPrisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 })
})

describe("POST /billing/webhook — event identity and idempotency", () => {
  it("a) Razorpay lifecycle sharing one resource id yields three distinct identities, all processed", async () => {
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
    expect(processRazorpayEventMock).toHaveBeenCalledTimes(3)
  })

  it("b) exact replay of a processed event answers 200 without reprocessing", async () => {
    const ev = rzEvent("subscription.charged", "sub_REPLAY", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)
    mockPrisma.webhookEvent.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      processed: true,
      createdAt: new Date(Date.now() - 120_000),
    })

    const res = await POST(razorpayRequest(ev))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(processRazorpayEventMock).not.toHaveBeenCalled()
    expect(mockPrisma.webhookEvent.updateMany).not.toHaveBeenCalled()
  })

  it("c) concurrent duplicate delivery processes exactly once, both answered 200", async () => {
    const ev = rzEvent("subscription.activated", "sub_RACE", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)

    // Simulate the DB unique constraint arbitrating two simultaneous inserts:
    // first create wins, second hits P2002 while the row is fresh/unprocessed.
    let calls = 0
    mockPrisma.webhookEvent.create.mockImplementation(async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error("unique"), { code: "P2002" })
      return {}
    })
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      processed: false,
      createdAt: new Date(), // winner still in-flight
    })
    // Slow winner down so the loser's arbiter check lands mid-processing.
    processRazorpayEventMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return {}
    })

    const [resA, resB] = await Promise.all([POST(razorpayRequest(ev)), POST(razorpayRequest(ev))])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(processRazorpayEventMock).toHaveBeenCalledTimes(1)
    expect(mockPrisma.webhookEvent.updateMany).toHaveBeenCalledTimes(1)
  })

  it("d) out-of-order lifecycle events each process independently on arrival", async () => {
    // Cancelled arrives before charged/activated.
    const cancelled = rzEvent("subscription.cancelled", "sub_OOO", 1_755_172_800)
    const activated = rzEvent("subscription.activated", "sub_OOO", 1_755_000_000)
    for (const ev of [cancelled, activated]) {
      validateRazorpayMock.mockReturnValue(ev)
      const res = await POST(razorpayRequest(ev))
      expect(res.status).toBe(200)
      expect(processRazorpayEventMock).toHaveBeenCalled()
    }
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(2)
    const [firstId, secondId] = mockPrisma.webhookEvent.create.mock.calls.map(
      (c: [{ data: { externalId: string } }]) => c[0].data.externalId
    )
    expect(firstId).not.toBe(secondId)
  })

  it("e) missing signature → 401, non-retryable class, no DB write", async () => {
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

  it("e2) unrecognized provider → 400, no validation attempted", async () => {
    const res = await POST(
      new Request("http://localhost/billing/webhook", { method: "POST", body: "{}" })
    )
    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
  })

  it("f) invalid signature → 401, non-retryable class, no DB write", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookAuthError("invalid_signature", "Invalid Razorpay webhook signature")
    })

    const res = await POST(razorpayRequest(rzEvent("subscription.charged", "sub_BADSIG", 1)))

    expect(res.status).toBe(401)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(processRazorpayEventMock).not.toHaveBeenCalled()
  })

  it("g) valid signature but malformed payload → 400, non-retryable", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookPayloadError("Razorpay webhook body is not valid JSON")
    })

    const res = await POST(razorpayRequest("{not-json"))

    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
    expect(dispatchAffiliateMock).not.toHaveBeenCalled()
  })

  it("h) verified payload + handler failure → 5xx so provider retries", async () => {
    validateRazorpayMock.mockReturnValue(rzEvent("subscription.charged", "sub_FAIL", 1_755_000_000))
    processRazorpayEventMock.mockRejectedValue(new Error("db unavailable"))

    const res = await POST(
      razorpayRequest(rzEvent("subscription.charged", "sub_FAIL", 1_755_000_000))
    )

    expect(res.status).toBe(500)
    // Row stays unprocessed for redelivery.
    expect(mockPrisma.webhookEvent.updateMany).not.toHaveBeenCalled()
  })

  it("h2) stale-timestamp rejection is classified 400 non-retryable", async () => {
    validateRazorpayMock.mockImplementation(() => {
      throw new WebhookAuthError("stale_timestamp", "outside tolerance")
    })

    const res = await POST(razorpayRequest(rzEvent("subscription.charged", "sub_OLD", 1)))

    expect(res.status).toBe(400)
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
  })

  it("i) derived-identity determinism: same inputs → same id; different type/timestamp/resource → different id", async () => {
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

  it("j) Razorpay delivery-id header is persisted as identity source 'delivery'", async () => {
    const ev = rzEvent("subscription.charged", "sub_HDR", 1_755_000_000)
    validateRazorpayMock.mockReturnValue(ev)

    const res = await POST(
      razorpayRequest(ev, {
        "x-razorpay-signature": "valid-sig",
        "x-razorpay-event-id": "evt_DELIVERY_1",
      })
    )

    expect(res.status).toBe(200)
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: "razorpay",
        externalId: "evt_DELIVERY_1",
        identitySource: "delivery",
      }),
    })
  })
})
