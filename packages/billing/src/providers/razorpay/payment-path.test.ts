import { beforeEach, describe, expect, it, vi } from "vitest"

const creditTopUpMock = vi.hoisted(() => vi.fn())
const resolveCatalogMock = vi.hoisted(() => vi.fn())
vi.mock("../../usage/packs", () => ({ creditTopUp: creditTopUpMock }))
vi.mock("../../usage/refund", () => ({ reverseRefund: vi.fn() }))
vi.mock("../../sync", () => ({ syncSubscription: vi.fn() }))
vi.mock("../../provider-catalog-validation", () => ({
  resolveRazorpayCatalogEvent: (...args: unknown[]) => resolveCatalogMock(...args),
}))
vi.mock("@lyrashield/pricing", () => ({ MINUTE_PACK_MAP: {} }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { processRazorpayEvent } from "./adapter"

describe("Razorpay captured non-pack payments", () => {
  beforeEach(() => {
    creditTopUpMock.mockReset()
    resolveCatalogMock.mockReset()
  })
  it("acknowledges the event without granting minute-pack entitlement", async () => {
    resolveCatalogMock.mockReturnValue(null)
    await expect(
      processRazorpayEvent({
        event: "payment.captured",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: "pay_subscription",
              amount: 2_900_00,
              currency: "INR",
              notes: { workspaceId: "workspace_1" },
            },
          },
        },
      })
    ).resolves.toEqual({
      handled: false,
      action: "payment.captured.non_pack",
      workspaceId: "workspace_1",
    })
    expect(creditTopUpMock).not.toHaveBeenCalled()
  })

  it("validates a pack Payment Link but leaves payment.captured as the sole grant", async () => {
    resolveCatalogMock.mockReturnValue({ kind: "pack", packId: "pack_100" })
    await expect(
      processRazorpayEvent({
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment_link: { entity: { id: "plink_pack", notes: { packId: "pack_100" } } },
          payment: {
            entity: { id: "pay_pack", amount: 150_000, currency: "INR", notes: {} },
          },
        },
      })
    ).resolves.toEqual({
      handled: true,
      action: "payment_link.paid.received",
      workspaceId: null,
    })
    expect(creditTopUpMock).not.toHaveBeenCalled()
  })

  it("records Local Payment Links without cloud credit", async () => {
    resolveCatalogMock.mockReturnValue({ kind: "local", sku: "individual_launch" })
    await expect(
      processRazorpayEvent({
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: { payment_link: { entity: { id: "plink_local", notes: {} } } },
      })
    ).resolves.toEqual({
      handled: true,
      action: "payment_link.paid.received",
      workspaceId: null,
    })
    expect(creditTopUpMock).not.toHaveBeenCalled()
  })

  it("classifies unrelated Payment Links as no-effect", async () => {
    resolveCatalogMock.mockReturnValue(null)
    await expect(
      processRazorpayEvent({
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: { payment_link: { entity: { id: "plink_unrelated", notes: {} } } },
      })
    ).resolves.toEqual({
      handled: false,
      action: "payment_link.paid.unrelated",
      workspaceId: null,
    })
    expect(creditTopUpMock).not.toHaveBeenCalled()
  })
})
