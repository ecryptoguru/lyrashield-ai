import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  admin,
  executeMutation,
  enqueueRetry,
  trackFindUnique,
  eventFindUnique,
  executeRaw,
  events,
} = vi.hoisted(() => ({
  admin: vi.fn(),
  executeMutation: vi.fn(),
  enqueueRetry: vi.fn(),
  trackFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  events: [] as string[],
}))

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue({}),
  requirePlatformAdmin: (...args: unknown[]) => admin(...args),
}))
vi.mock("@lyrashield/db", () => ({
  executePlatformAdminMutation: (...args: unknown[]) => executeMutation(...args),
}))
vi.mock("@lyrashield/integrations", () => ({
  enqueueWebhookTrackRetry: (...args: unknown[]) => enqueueRetry(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestIdResolver: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" },
}))

import { POST } from "./route"
import { WEBHOOK_TRACK_MAX_ATTEMPTS } from "@lyrashield/billing"

const action = "billing.webhook-track.retry"
const nonce = "A".repeat(43)
const adminIdentity = { userId: "admin-1", sessionId: "session-1" }
const tx = {
  webhookEventTrack: { findUnique: trackFindUnique },
  webhookEvent: { findUnique: eventFindUnique },
  $executeRaw: executeRaw,
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/admin/webhook-tracks/track-1/retry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      cookie: "better-auth.session_token=signed",
      "x-lyrashield-admin-elevation": nonce,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function packEvent() {
  return {
    provider: "polar",
    externalId: "delivery-1",
    eventType: "order.paid",
    deletedAt: null,
    payload: {
      type: "order.paid",
      data: {
        id: "order-1",
        amount: 1500,
        currency: "USD",
        metadata: { workspaceId: "workspace-1", accountId: "account-1", packId: "pack_100" },
      },
    },
  }
}

function deadTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: "track-1",
    webhookEventId: "event-1",
    track: "billing",
    status: "dead_letter",
    attempts: WEBHOOK_TRACK_MAX_ATTEMPTS,
    historicalAttempts: 7,
    operatorRecoveryCount: 0,
    generation: 7,
    claimToken: null,
    leaseExpiresAt: null,
    leaseExpiresAtUtc: null,
    nextAttemptAt: null,
    nextAttemptAtUtc: null,
    ...overrides,
  }
}

describe("POST /api/admin/webhook-tracks/[id]/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    events.length = 0
    admin.mockResolvedValue(adminIdentity)
    trackFindUnique.mockResolvedValue(deadTrack())
    eventFindUnique.mockResolvedValue(packEvent())
    executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      events.push("cas")
      const sql = strings.join(" $ ")
      expect(sql).toContain("status = 'dead_letter'")
      expect(sql).toContain('"nextAttemptAtUtc" = now()')
      expect(sql).toContain('"historicalAttempts" = "historicalAttempts" + attempts')
      expect(sql).toContain("attempts = 0")
      expect(sql).toContain('"operatorRecoveryCount" = "operatorRecoveryCount" + 1')
      expect(sql).toContain('"claimToken" IS NULL')
      expect(sql).toContain('"leaseExpiresAt" IS NULL')
      expect(sql).toContain('"leaseExpiresAtUtc" IS NULL')
      expect(values).toEqual(expect.arrayContaining(["track-1", "event-1", 7]))
      return 1
    })
    executeMutation.mockImplementation(async (input, mutate) => {
      events.push("transaction-start")
      const result = await mutate(tx)
      expect(input).toMatchObject({
        action,
        resourceType: "WebhookEventTrack",
        resourceId: "track-1",
        metadata: { expectedGeneration: 7 },
      })
      expect(["provider_receipt_reviewed", "transient_failure_corrected"]).toContain(
        input.metadata.reason
      )
      events.push("transaction-committed")
      return result
    })
    enqueueRetry.mockImplementation(async () => {
      events.push("enqueue")
      return "job-1"
    })
  })

  it("audits and enqueues an eligible minute-pack purchase after the CAS transaction commits", async () => {
    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(202)
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: "scheduled", queued: true, generation: 8 },
    })
    expect(executeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        action,
        nonce,
        resourceType: "WebhookEventTrack",
        resourceId: "track-1",
      }),
      expect.any(Function)
    )
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(enqueueRetry).toHaveBeenCalledTimes(1)
    expect(enqueueRetry).toHaveBeenCalledWith({
      webhookEventId: "event-1",
      track: "billing",
      generation: 8,
    })
    expect(events).toEqual(["transaction-start", "cas", "transaction-committed", "enqueue"])
  })

  it.each([
    ["pending", 0],
    ["failed", 1],
    ["processing", 1],
  ])(
    "recovers a receipt-reviewed historical null-due %s minute pack without inline replay",
    async (status, attempts) => {
      trackFindUnique.mockResolvedValue(deadTrack({ status, attempts }))

      const response = await POST(
        request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
        { params: Promise.resolve({ id: "track-1" }) }
      )

      expect(response.status, JSON.stringify(await response.clone().json())).toBe(202)
      expect(executeRaw).toHaveBeenCalledTimes(1)
      expect(enqueueRetry).toHaveBeenCalledWith({
        webhookEventId: "event-1",
        track: "billing",
        generation: 8,
      })
    }
  )

  it("allows only a provider-proven full minute-pack refund for the refund path", async () => {
    eventFindUnique.mockResolvedValue({
      provider: "polar",
      externalId: "refund-delivery-1",
      eventType: "order.refunded",
      payload: {
        type: "order.refunded",
        data: {
          id: "order-1",
          status: "refunded",
          total_amount: 1500,
          currency: "USD",
          metadata: { workspaceId: "workspace-1", packId: "pack_100" },
        },
      },
      deletedAt: null,
    })

    const response = await POST(
      request({ expectedGeneration: 7, reason: "transient_failure_corrected" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(202)
    expect(enqueueRetry).toHaveBeenCalledWith({
      webhookEventId: "event-1",
      track: "billing",
      generation: 8,
    })
  })

  it("accepts a provider-proven full Razorpay minute-pack refund", async () => {
    eventFindUnique.mockResolvedValue({
      provider: "razorpay",
      externalId: "refund-delivery-2",
      eventType: "refund.created",
      payload: {
        event: "refund.created",
        payload: {
          payment: {
            entity: {
              id: "payment-1",
              order_id: "order-2",
              amount: 150_000,
              amount_refunded: 150_000,
              currency: "INR",
              refund_status: "full",
              notes: { workspaceId: "workspace-1", packId: "pack_100" },
            },
          },
          refund: {
            entity: {
              id: "refund-1",
              payment_id: "payment-1",
              amount: 150_000,
              currency: "INR",
              status: "processed",
            },
          },
        },
      },
      deletedAt: null,
    })

    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(202)
    expect(enqueueRetry).toHaveBeenCalledWith({
      webhookEventId: "event-1",
      track: "billing",
      generation: 8,
    })
  })

  it.each([
    [
      "subscription event",
      {
        ...packEvent(),
        payload: {
          type: "order.paid",
          data: {
            id: "order-1",
            amount: 4900,
            currency: "USD",
            subscription_id: "sub-1",
            metadata: { planId: "pro" },
          },
        },
      },
    ],
    ["non-provider event", { ...packEvent(), provider: "github" }],
    ["unknown provider event", { ...packEvent(), eventType: "unknown.event" }],
    [
      "Local SKU event",
      {
        ...packEvent(),
        payload: {
          type: "order.paid",
          data: {
            id: "order-local",
            productId: "individual_regular",
            amount: 4900,
            currency: "USD",
          },
        },
      },
    ],
    [
      "partial minute-pack refund",
      {
        ...packEvent(),
        eventType: "order.refunded",
        payload: {
          type: "order.refunded",
          data: {
            id: "order-partial",
            status: "partially_refunded",
            total_amount: 1500,
            currency: "USD",
            metadata: { packId: "pack_100" },
          },
        },
      },
    ],
    ["deleted parent receipt", { ...packEvent(), deletedAt: new Date() }],
  ])("rejects an unsafe %s without changing state", async (_name, event) => {
    eventFindUnique.mockResolvedValue(event)

    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(executeRaw).not.toHaveBeenCalled()
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  it.each([
    ["invalid attempt count", { attempts: WEBHOOK_TRACK_MAX_ATTEMPTS + 1 }],
    ["operator recovery limit", { operatorRecoveryCount: 3 }],
    ["active claim", { claimToken: "claimed" }],
    ["legacy lease", { leaseExpiresAt: new Date() }],
    ["active lease", { leaseExpiresAtUtc: new Date() }],
    // A processing row with no claim or lease is an explicitly supported
    // orphaned historical row; keep this rejection case actively owned.
    ["wrong state", { status: "processing", claimToken: "active" }],
    ["stale generation", { generation: 6 }],
  ])("rejects a stale or exhausted %s track", async (_name, overrides) => {
    trackFindUnique.mockResolvedValue(deadTrack(overrides))

    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(executeRaw).not.toHaveBeenCalled()
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  it("uses compare-and-swap and rolls back the audit when another operator wins the race", async () => {
    executeRaw.mockResolvedValue(0)

    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(enqueueRetry).not.toHaveBeenCalled()
    expect(events).not.toContain("transaction-committed")
  })

  it("leaves the committed due row recoverable when Redis enqueue fails", async () => {
    enqueueRetry.mockRejectedValue(new Error("private redis detail"))

    const response = await POST(
      request({ expectedGeneration: 7, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: "scheduled", queued: false, generation: 8 },
    })
    expect(enqueueRetry).toHaveBeenCalledWith({
      webhookEventId: "event-1",
      track: "billing",
      generation: 8,
    })
    expect(events).toEqual(["transaction-start", "cas", "transaction-committed"])
  })

  it("requires same-origin cookie action input with a valid nonce and bounded reason", async () => {
    const noNonce = await POST(
      request(
        { expectedGeneration: 7, reason: "provider_receipt_reviewed" },
        {
          "x-lyrashield-admin-elevation": "bad",
        }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )
    const crossOrigin = await POST(
      request(
        { expectedGeneration: 7, reason: "provider_receipt_reviewed" },
        {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )
    const invalidReason = await POST(
      request({ expectedGeneration: 7, reason: "copied secret: customer email is private" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )
    const invalidGeneration = await POST(
      request({ expectedGeneration: 2_147_483_647, reason: "provider_receipt_reviewed" }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(noNonce.status).toBe(403)
    expect(crossOrigin.status).toBe(403)
    expect(invalidReason.status).toBe(400)
    expect(invalidGeneration.status).toBe(400)
    expect(admin).toHaveBeenCalledTimes(2)
    expect(executeMutation).not.toHaveBeenCalled()
  })

  it("rejects API-key-style sessions through the platform-admin cookie boundary", async () => {
    admin.mockRejectedValue(new Error("UNAUTHORIZED"))

    const response = await POST(
      request(
        { expectedGeneration: 7, reason: "provider_receipt_reviewed" },
        { authorization: "Bearer key" }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(401)
    expect(executeMutation).not.toHaveBeenCalled()
    expect(enqueueRetry).not.toHaveBeenCalled()
  })
})
