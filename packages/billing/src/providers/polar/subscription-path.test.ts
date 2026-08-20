import { describe, expect, it, vi } from "vitest"

vi.mock("../../sync", () => ({
  syncSubscription: vi.fn().mockResolvedValue(undefined),
  downgradeToFree: vi.fn(),
}))

vi.mock("../../usage/packs", () => ({ creditTopUp: vi.fn() }))
vi.mock("../../usage/refund", () => ({ reverseRefund: vi.fn() }))
vi.mock("@lyrashield/pricing", () => ({ MINUTE_PACK_MAP: {} }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { syncSubscription } from "../../sync"
import { processPolarEvent } from "./adapter"

describe("Polar subscription events", () => {
  it("uses Polar's snake_case period fields and preserves scheduled cancellation access", async () => {
    const event = {
      type: "subscription.canceled",
      data: {
        id: "sub_1",
        status: "active",
        current_period_start: "2026-08-20T00:00:00Z",
        current_period_end: "2026-09-20T00:00:00Z",
        canceled_at: "2026-08-20T12:00:00Z",
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
      })
    )
  })

  it("records a past-due lifecycle event", async () => {
    await expect(
      processPolarEvent({
        type: "subscription.past_due",
        data: { id: "sub_2", metadata: { workspaceId: "ws_1" } },
      })
    ).resolves.toMatchObject({ action: "subscription.past_due" })
  })
})
