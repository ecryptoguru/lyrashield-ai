import { beforeEach, describe, expect, it, vi } from "vitest"

const { admin, executeMutation, trackFindUnique, eventFindUnique, countTracks, executeRaw } =
  vi.hoisted(() => ({
    admin: vi.fn(),
    executeMutation: vi.fn(),
    trackFindUnique: vi.fn(),
    eventFindUnique: vi.fn(),
    countTracks: vi.fn(),
    executeRaw: vi.fn(),
  }))

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue({}),
  requirePlatformAdmin: (...args: unknown[]) => admin(...args),
}))
vi.mock("@lyrashield/db", () => ({
  executePlatformAdminMutation: (...args: unknown[]) => executeMutation(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestIdResolver: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" },
}))

import { POST } from "./route"

const nonce = "A".repeat(43)
const adminIdentity = { userId: "admin-1", sessionId: "session-1" }
const tx = {
  webhookEventTrack: { findUnique: trackFindUnique, count: countTracks },
  webhookEvent: { findUnique: eventFindUnique },
  $executeRaw: executeRaw,
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/admin/webhook-tracks/track-1/disposition", {
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

function unsafeEvent() {
  return {
    provider: "polar",
    externalId: "delivery-1",
    eventType: "subscription.updated",
    deletedAt: null,
    payload: { type: "subscription.updated", data: { id: "sub-1" } },
  }
}

function unsafeTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: "track-1",
    webhookEventId: "event-1",
    track: "affiliate",
    status: "dead_letter",
    attempts: 5,
    generation: 7,
    claimToken: null,
    leaseExpiresAt: null,
    leaseExpiresAtUtc: null,
    nextAttemptAt: null,
    nextAttemptAtUtc: null,
    ...overrides,
  }
}

describe("POST /api/admin/webhook-tracks/[id]/disposition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    admin.mockResolvedValue(adminIdentity)
    trackFindUnique.mockResolvedValue(unsafeTrack())
    eventFindUnique.mockResolvedValue(unsafeEvent())
    countTracks.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ")
      if (sql.includes('UPDATE "WebhookEventTrack"')) {
        expect(sql).toContain("status = 'reviewed'")
        expect(sql).toContain("generation = generation + 1")
        expect(sql).toContain('"nextAttemptAtUtc" = NULL')
        expect(sql).toContain('"claimToken" IS NULL')
        expect(sql).toContain('"leaseExpiresAt" IS NULL')
        expect(sql).toContain('"leaseExpiresAtUtc" IS NULL')
        return 1
      }
      if (sql.includes('UPDATE "WebhookEvent"')) {
        expect(sql).toContain("processed = true")
        return 1
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    executeMutation.mockImplementation(async (input, mutate) => {
      const result = await mutate(tx)
      expect(input).toMatchObject({
        action: "billing.webhook-track.disposition",
        resourceType: "WebhookEventTrack",
        resourceId: "track-1",
        metadata: { expectedGeneration: 7 },
      })
      expect(["effect_confirmed", "no_effect_required"]).toContain(input.metadata.reason)
      expect(input.metadata.evidenceReference).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,127}$/)
      return result
    })
  })

  it("audits a reviewed dead letter without replay and closes the parent only when all tracks resolve", async () => {
    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "effect_confirmed",
        evidenceReference: "INC-4821",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: "reviewed", processed: true, generation: 8 },
    })
    expect(executeMutation).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing.webhook-track.disposition", nonce }),
      expect.any(Function)
    )
    expect(executeRaw).toHaveBeenCalledTimes(2)
  })

  it("does not mark the parent processed when another required track is unresolved", async () => {
    countTracks.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(1)

    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "no_effect_required",
        evidenceReference: "PAY-9912",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: "reviewed", processed: false, generation: 8 },
    })
    expect(executeRaw).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["historical pending row without either due timestamp", { status: "pending" }],
    ["historical failed row without either due timestamp", { status: "failed", attempts: 1 }],
    [
      "orphaned historical processing row without claim or due timestamps",
      { status: "processing", attempts: 1 },
    ],
  ])("allows a receipt-reviewed disposition for %s", async (_label, overrides) => {
    trackFindUnique.mockResolvedValue(unsafeTrack(overrides))

    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "no_effect_required",
        evidenceReference: "PAY-9912",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(200)
  })

  it("refuses to disposition an event that remains replay-safe for the retry endpoint", async () => {
    eventFindUnique.mockResolvedValue({
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
          metadata: { accountId: "account-1", workspaceId: "workspace-1", packId: "pack_100" },
        },
      },
    })
    trackFindUnique.mockResolvedValue(unsafeTrack({ track: "billing" }))

    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "effect_confirmed",
        evidenceReference: "INC-4821",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it("rejects a compare-and-swap loss without committing an audit or marking the parent", async () => {
    executeRaw.mockResolvedValueOnce(0)
    const committed: string[] = []
    executeMutation.mockImplementation(async (_input, mutate) => {
      const result = await mutate(tx)
      committed.push("audit")
      return result
    })

    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "effect_confirmed",
        evidenceReference: "INC-4821",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(committed).toEqual([])
    expect(executeRaw).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["stale generation", { generation: 6 }],
    ["active processing row", { status: "processing", claimToken: "active" }],
    ["legacy active lease", { leaseExpiresAt: new Date() }],
    ["already succeeded row", { status: "succeeded" }],
    ["failed row with a scheduled retry", { status: "failed", nextAttemptAtUtc: new Date() }],
  ])("rejects a %s without mutating or invoking a handler", async (_label, overrides) => {
    trackFindUnique.mockResolvedValue(unsafeTrack(overrides))

    const response = await POST(
      request({
        expectedGeneration: 7,
        reason: "effect_confirmed",
        evidenceReference: "INC-4821",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(409)
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it("requires an action-specific elevation, same-origin cookie request and bounded evidence", async () => {
    const noNonce = await POST(
      request(
        {
          expectedGeneration: 7,
          reason: "effect_confirmed",
          evidenceReference: "INC-4821",
        },
        { "x-lyrashield-admin-elevation": "bad" }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )
    const badEvidence = await POST(
      request({
        expectedGeneration: 7,
        reason: "effect_confirmed",
        evidenceReference: "customer email and secret token",
      }),
      { params: Promise.resolve({ id: "track-1" }) }
    )
    const crossOrigin = await POST(
      request(
        {
          expectedGeneration: 7,
          reason: "effect_confirmed",
          evidenceReference: "INC-4821",
        },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(noNonce.status).toBe(403)
    expect(badEvidence.status).toBe(400)
    expect(crossOrigin.status).toBe(403)
    expect(executeMutation).not.toHaveBeenCalled()
  })

  it("rejects API-key sessions at the platform-admin cookie boundary", async () => {
    admin.mockRejectedValue(new Error("UNAUTHORIZED"))

    const response = await POST(
      request(
        {
          expectedGeneration: 7,
          reason: "effect_confirmed",
          evidenceReference: "INC-4821",
        },
        { authorization: "Bearer key" }
      ),
      { params: Promise.resolve({ id: "track-1" }) }
    )

    expect(response.status).toBe(401)
    expect(executeMutation).not.toHaveBeenCalled()
  })
})
