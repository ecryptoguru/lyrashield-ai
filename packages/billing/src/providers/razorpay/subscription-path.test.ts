import { beforeEach, describe, expect, it, vi } from "vitest"

const syncSubscriptionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const downgradeToFreeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const resolveCatalogMock = vi.hoisted(() => vi.fn())

vi.mock("../../sync", () => ({
  syncSubscription: syncSubscriptionMock,
  downgradeToFree: downgradeToFreeMock,
}))
vi.mock("../../usage/packs", () => ({ creditTopUp: vi.fn() }))
vi.mock("../../usage/refund", () => ({ reverseRefund: vi.fn() }))
vi.mock("../../provider-catalog-validation", () => ({
  resolveRazorpayCatalogEvent: (...args: unknown[]) => resolveCatalogMock(...args),
}))
vi.mock("@lyrashield/pricing", () => ({ MINUTE_PACK_MAP: {} }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { processRazorpayEvent } from "./adapter"
import { isHandledRazorpayEvent } from "./webhooks"

const timestamp = Math.floor(Date.now() / 1000)

function subscriptionEvent(event: string, status = "active") {
  return {
    event,
    created_at: timestamp,
    payload: {
      subscription: {
        entity: {
          id: "sub_1",
          status,
          plan_id: "plan_starter_monthly",
          current_start: timestamp,
          current_end: timestamp + 2_592_000,
          notes: { workspaceId: "ws_1", plan: "STARTER", interval: "monthly" },
        },
      },
    },
  }
}

describe("Razorpay subscription lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveCatalogMock.mockReturnValue({ kind: "plan", plan: "STARTER", interval: "monthly" })
  })

  it.each([
    ["subscription.activated", "active"],
    ["subscription.charged", "active"],
    ["subscription.resumed", "active"],
    ["subscription.pending", "past_due"],
    ["subscription.halted", "past_due"],
    ["subscription.paused", "paused"],
    ["subscription.cancelled", "canceled"],
  ] as const)("maps %s to %s", async (event, status) => {
    await expect(processRazorpayEvent(subscriptionEvent(event))).resolves.toMatchObject({
      handled: true,
      action: `subscription.${status}`,
      workspaceId: "ws_1",
    })
    expect(syncSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ status, workspaceId: "ws_1" })
    )
  })

  it("records authenticated and updated receipts without changing entitlement", async () => {
    for (const event of ["subscription.authenticated", "subscription.updated"]) {
      await expect(processRazorpayEvent(subscriptionEvent(event))).resolves.toEqual({
        handled: true,
        action: `${event}.recorded`,
        workspaceId: "ws_1",
      })
    }
    expect(syncSubscriptionMock).not.toHaveBeenCalled()
    expect(downgradeToFreeMock).not.toHaveBeenCalled()
  })

  it("ends paid access once when Razorpay completes a subscription", async () => {
    await expect(
      processRazorpayEvent(subscriptionEvent("subscription.completed"))
    ).resolves.toEqual({
      handled: true,
      action: "subscription.ended",
      workspaceId: "ws_1",
    })
    expect(downgradeToFreeMock).toHaveBeenCalledWith("ws_1", "subscription.completed")
    expect(syncSubscriptionMock).not.toHaveBeenCalled()
  })

  it("accepts every required lifecycle event", () => {
    for (const event of [
      "subscription.authenticated",
      "subscription.activated",
      "subscription.charged",
      "subscription.pending",
      "subscription.halted",
      "subscription.paused",
      "subscription.resumed",
      "subscription.cancelled",
      "subscription.completed",
      "subscription.updated",
    ]) {
      expect(isHandledRazorpayEvent(event)).toBe(true)
    }
  })
})
