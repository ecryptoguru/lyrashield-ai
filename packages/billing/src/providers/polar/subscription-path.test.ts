import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../sync", () => ({
  syncSubscription: vi.fn().mockResolvedValue(undefined),
  downgradeToFree: vi.fn(),
}))

vi.mock("../../usage/packs", () => ({ creditTopUp: vi.fn() }))
vi.mock("../../usage/refund", () => ({ reverseRefund: vi.fn() }))
vi.mock("@lyrashield/pricing", () => ({ MINUTE_PACK_MAP: {} }))
vi.mock("../../provider-catalog-validation", () => ({
  resolvePolarCatalogEvent: () => ({ kind: "plan", plan: "PRO", interval: "annual" }),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { syncSubscription } from "../../sync"
import { processPolarEvent } from "./adapter"

describe("Polar subscription events", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses Polar's snake_case period fields and preserves scheduled cancellation access", async () => {
    const event = {
      type: "subscription.canceled",
      data: {
        id: "sub_1",
        status: "active",
        current_period_start: "2026-08-20T00:00:00Z",
        current_period_end: "2026-09-20T00:00:00Z",
        canceled_at: "2026-08-20T12:00:00Z",
        modified_at: "2026-08-20T12:00:01Z",
        metadata: { workspaceId: "ws_1", plan: "PRO", interval: "annual" },
      },
    }

    await expect(processPolarEvent(event)).resolves.toMatchObject({
      handled: true,
      action: "subscription.active",
      workspaceId: "ws_1",
    })
    expect(syncSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        currentPeriodStart: new Date("2026-08-20T00:00:00Z"),
        currentPeriodEnd: new Date("2026-09-20T00:00:00Z"),
        canceledAt: new Date("2026-08-20T12:00:00Z"),
        eventOccurredAt: new Date("2026-08-20T12:00:01Z"),
      })
    )
  })

  it("records a past-due lifecycle event", async () => {
    await expect(
      processPolarEvent({
        type: "subscription.past_due",
        data: {
          id: "sub_2",
          modified_at: "2026-08-20T12:00:01Z",
          metadata: { workspaceId: "ws_1" },
        },
      })
    ).resolves.toMatchObject({ action: "subscription.past_due" })
  })

  it.each(
    [
      "current_period_start",
      "currentPeriodStart",
      "current_period_end",
      "currentPeriodEnd",
      "canceled_at",
      "canceledAt",
    ].flatMap((field) => ["invalid", "", 0, false, {}].map((value) => [field, value] as const))
  )("rejects malformed %s before subscription sync: %j", async (field, value) => {
    await expect(
      processPolarEvent({
        type: "subscription.revoked",
        data: {
          id: "sub_invalid_period",
          [field]: value,
          modified_at: "2026-08-20T12:00:01Z",
          metadata: { accountId: "account_1" },
        },
      })
    ).rejects.toThrow("polar_subscription_time_invalid")
    expect(syncSubscription).not.toHaveBeenCalled()
  })

  it("preserves valid camelCase periods and nullable cancellation", async () => {
    await processPolarEvent({
      type: "subscription.active",
      data: {
        id: "sub_camel",
        currentPeriodStart: "2026-08-01T00:00:00Z",
        currentPeriodEnd: "2026-09-01T00:00:00Z",
        canceledAt: null,
        modified_at: "2026-08-20T12:00:01Z",
        metadata: { accountId: "account_1" },
      },
    })
    expect(syncSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
        canceledAt: undefined,
      })
    )
  })

  it("fails closed when the provider event clock is missing", async () => {
    await expect(
      processPolarEvent({
        type: "subscription.active",
        data: { id: "sub_3", metadata: { workspaceId: "ws_1" } },
      })
    ).rejects.toThrow("polar_subscription_event_time_invalid")
    expect(syncSubscription).not.toHaveBeenCalled()
  })

  it.each([
    ["subscription.revoked", "canceled", { ended_at: "2026-08-20T12:00:00Z" }],
    ["subscription.updated", "canceled", { ended_at: "2026-08-20T12:00:00Z" }],
    ["subscription.updated", "canceled", { endedAt: "2026-08-20T12:00:00Z" }],
    ["subscription.updated", "unpaid", { ended_at: "2026-08-20T12:00:00Z" }],
    ["subscription.updated", "incomplete_expired", { ended_at: "2026-08-20T12:00:00Z" }],
  ])(
    "ends paid access on %s/%s at the provider termination time",
    async (type, status, termination) => {
      await processPolarEvent({
        type,
        data: {
          id: "sub_ended",
          status,
          ...termination,
          current_period_start: "2026-08-01T00:00:00Z",
          current_period_end: "2027-08-01T00:00:00Z",
          modified_at: "2026-08-20T12:00:01Z",
          metadata: { workspaceId: "ws_1", accountId: "account_1" },
        },
      })
      expect(syncSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: "sub_ended",
          accountId: "account_1",
          status: "canceled",
          currentPeriodEnd: new Date("2026-08-20T12:00:00Z"),
        })
      )
    }
  )

  it("uses the provider event clock for a revocation without ended_at", async () => {
    await processPolarEvent({
      type: "subscription.revoked",
      data: {
        id: "sub_ended",
        current_period_end: "2027-08-01T00:00:00Z",
        modified_at: "2026-08-20T12:00:01Z",
        metadata: { accountId: "account_1" },
      },
    })
    expect(syncSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        currentPeriodEnd: new Date("2026-08-20T12:00:01Z"),
      })
    )
  })

  it.each(["invalid", "2027-08-01T00:00:00Z"])(
    "rejects an invalid or future termination timestamp: %s",
    async (ended_at) => {
      await expect(
        processPolarEvent({
          type: "subscription.revoked",
          data: {
            id: "sub_ended",
            ended_at,
            modified_at: "2026-08-20T12:00:01Z",
            metadata: { accountId: "account_1" },
          },
        })
      ).rejects.toThrow("polar_subscription_end_time_invalid")
      expect(syncSubscription).not.toHaveBeenCalled()
    }
  )

  it("rejects contradictory active state after termination", async () => {
    await expect(
      processPolarEvent({
        type: "subscription.updated",
        data: {
          id: "sub_ended",
          status: "active",
          ended_at: "2026-08-20T12:00:00Z",
          modified_at: "2026-08-20T12:00:01Z",
          metadata: { accountId: "account_1" },
        },
      })
    ).rejects.toThrow("polar_subscription_end_state_invalid")
    expect(syncSubscription).not.toHaveBeenCalled()
  })
  it.each(["subscription.updated", "subscription.active", "subscription.resumed"])(
    "rejects unknown paid state on %s",
    async (type) => {
      await expect(
        processPolarEvent({
          type,
          data: {
            id: "sub_unknown",
            status: "future_status",
            modified_at: "2026-08-20T12:00:01Z",
            metadata: { accountId: "account_1" },
          },
        })
      ).rejects.toThrow("polar_subscription_status_invalid")
      expect(syncSubscription).not.toHaveBeenCalled()
    }
  )
})
