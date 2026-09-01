import { beforeEach, describe, expect, it, vi } from "vitest"

const envState = vi.hoisted(() => ({
  POLAR_PRODUCT_IDS: JSON.stringify({
    pack_100: "polar-pack-100",
    pack_500: "polar-pack-500",
    pro_monthly: "polar-pro-monthly",
  }),
  POLAR_LOCAL_PRODUCT_IDS: JSON.stringify({ individual_launch: "polar-local-launch" }),
  RAZORPAY_PLAN_IDS: JSON.stringify({ launch_assurance_annual: "plan-launch-assurance-annual" }),
  BILLING_USD_INR_RATE: 100,
  LYRASHIELD_INTERNAL_API_KEY: "test-internal-quote-secret",
}))

vi.mock("@lyrashield/config", () => ({ env: envState }))

import {
  resolvePolarCatalogEvent,
  resolveRazorpayCatalogEvent,
} from "./provider-catalog-validation"
import { billingQuoteNotes } from "./provider-quote"

function quoteNotes(params: {
  kind: "pack" | "local"
  workspaceId: string
  catalogKey: string
  amountMinor: number
}) {
  return billingQuoteNotes({ provider: "razorpay", currency: "INR", ...params })
}

describe("provider catalog entitlement validation", () => {
  beforeEach(() => {
    envState.BILLING_USD_INR_RATE = 100
    envState.POLAR_PRODUCT_IDS = JSON.stringify({
      pack_100: "polar-pack-100",
      pack_500: "polar-pack-500",
      pro_monthly: "polar-pro-monthly",
    })
    envState.POLAR_LOCAL_PRODUCT_IDS = JSON.stringify({ individual_launch: "polar-local-launch" })
    envState.RAZORPAY_PLAN_IDS = JSON.stringify({
      launch_assurance_annual: "plan-launch-assurance-annual",
    })
  })

  it("accepts a Polar pack only when provider id, metadata, currency, and amount agree", () => {
    expect(
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pack-500",
        currency: "USD",
        subtotal_amount: 5000,
        total_amount: 5000,
        metadata: { packId: "pack_500" },
      })
    ).toEqual({ kind: "pack", packId: "pack_500" })
  })

  it("accepts Cloud-only Polar installations with no Local product map", () => {
    envState.POLAR_LOCAL_PRODUCT_IDS = ""
    expect(
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pack-100",
        currency: "USD",
        subtotal_amount: 1500,
        metadata: { packId: "pack_100" },
      })
    ).toEqual({ kind: "pack", packId: "pack_100" })
  })

  it("rejects Polar metadata escalation and underpayment", () => {
    expect(() =>
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pack-100",
        currency: "USD",
        subtotal_amount: 1500,
        total_amount: 1500,
        metadata: { packId: "pack_500" },
      })
    ).toThrow(/catalog evidence/)
    expect(() =>
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pack-500",
        currency: "USD",
        subtotal_amount: 1500,
        total_amount: 1500,
        metadata: { packId: "pack_500" },
      })
    ).toThrow(/catalog evidence/)
  })

  it("accepts Polar tax and discount totals when the catalog subtotal is exact", () => {
    expect(
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pack-100",
        currency: "USD",
        subtotal_amount: 1500,
        discount_amount: 100,
        tax_amount: 252,
        net_amount: 1400,
        total_amount: 1652,
        metadata: { packId: "pack_100" },
      })
    ).toEqual({ kind: "pack", packId: "pack_100" })
  })

  it("accepts legacy Polar plan IDs and prorated recurring order subtotals", () => {
    envState.POLAR_PRODUCT_IDS = JSON.stringify({
      pro_monthly: ["polar-pro-current", "polar-pro-legacy"],
    })
    expect(
      resolvePolarCatalogEvent("order.paid", {
        product_id: "polar-pro-legacy",
        currency: "USD",
        subtotal_amount: 1732,
        total_amount: 1732,
        metadata: { plan: "PRO", interval: "monthly" },
      })
    ).toEqual({ kind: "plan", plan: "PRO", interval: "monthly" })
  })

  it("rejects a Razorpay pack that pays for 100 minutes but claims 500", () => {
    expect(() =>
      resolveRazorpayCatalogEvent("payment.captured", {
        payload: {
          payment: {
            entity: {
              amount: 150_000,
              currency: "INR",
              notes: { packId: "pack_500" },
            },
          },
        },
      })
    ).toThrow(/catalog evidence/)
  })

  it("accepts non-pack Razorpay captured payments without granting a pack", () => {
    expect(
      resolveRazorpayCatalogEvent("payment.captured", {
        payload: {
          payment: { entity: { amount: 2_900_00, currency: "INR", notes: {} } },
        },
      })
    ).toBeNull()
  })

  it("accepts a signed pending pack quote after the configured FX rate changes", () => {
    const amountMinor = Math.round(15 * 83.25 * 100)
    const notes = {
      workspaceId: "workspace-1",
      packId: "pack_100",
      ...quoteNotes({
        kind: "pack",
        workspaceId: "workspace-1",
        catalogKey: "pack_100",
        amountMinor,
      }),
    }
    envState.BILLING_USD_INR_RATE = 100
    expect(
      resolveRazorpayCatalogEvent("payment.captured", {
        payload: { payment: { entity: { amount: amountMinor, currency: "INR", notes } } },
      })
    ).toEqual({ kind: "pack", packId: "pack_100" })
  })

  it("rejects a valid quote when the paid amount differs", () => {
    const quotedAmount = 124_875
    const notes = {
      workspaceId: "workspace-1",
      packId: "pack_100",
      ...quoteNotes({
        kind: "pack",
        workspaceId: "workspace-1",
        catalogKey: "pack_100",
        amountMinor: quotedAmount,
      }),
    }
    expect(() =>
      resolveRazorpayCatalogEvent("payment.captured", {
        payload: {
          payment: { entity: { amount: quotedAmount - 1, currency: "INR", notes } },
        },
      })
    ).toThrow(/catalog evidence/)
  })

  it("classifies signed pack, Local, and unrelated Payment Links without granting here", () => {
    const packAmount = 150_000
    const packNotes = {
      workspaceId: "workspace-1",
      packId: "pack_100",
      ...quoteNotes({
        kind: "pack",
        workspaceId: "workspace-1",
        catalogKey: "pack_100",
        amountMinor: packAmount,
      }),
    }
    expect(
      resolveRazorpayCatalogEvent("payment_link.paid", {
        payload: { payment: { entity: { amount: packAmount, currency: "INR", notes: packNotes } } },
      })
    ).toEqual({ kind: "pack", packId: "pack_100" })

    const localAmount = 1_990_000
    const localNotes = {
      productId: "individual_launch",
      quoteWorkspaceId: "local-reference-1",
      ...quoteNotes({
        kind: "local",
        workspaceId: "local-reference-1",
        catalogKey: "individual_launch",
        amountMinor: localAmount,
      }),
    }
    expect(
      resolveRazorpayCatalogEvent("payment_link.paid", {
        payload: {
          payment: { entity: { amount: localAmount, currency: "INR", notes: localNotes } },
        },
      })
    ).toEqual({ kind: "local", sku: "individual_launch" })

    expect(
      resolveRazorpayCatalogEvent("payment_link.paid", {
        payload: { payment: { entity: { amount: 100, currency: "INR", notes: {} } } },
      })
    ).toBeNull()
  })

  it("treats missing or malformed provider maps as retryable configuration errors", () => {
    envState.POLAR_PRODUCT_IDS = "not-json"
    expect(() =>
      resolvePolarCatalogEvent("subscription.active", {
        product_id: "polar-pro-monthly",
        metadata: { plan: "PRO", interval: "monthly" },
      })
    ).toThrow(/POLAR_PRODUCT_IDS/)
  })

  it("accepts immutable legacy Razorpay plan IDs at their original renewal price", () => {
    envState.RAZORPAY_PLAN_IDS = JSON.stringify({
      launch_assurance_annual: ["plan-launch-assurance-current", "plan-launch-assurance-annual"],
    })
    const event = {
      payload: {
        subscription: {
          entity: {
            plan_id: "plan-launch-assurance-annual",
            notes: { plan: "LAUNCH_ASSURANCE", interval: "annual" },
          },
        },
        payment: { entity: { amount: 41_880_000, currency: "INR" } },
      },
    }
    expect(resolveRazorpayCatalogEvent("subscription.charged", event)).toEqual({
      kind: "plan",
      plan: "LAUNCH_ASSURANCE",
      interval: "annual",
    })
    expect(() =>
      resolveRazorpayCatalogEvent("subscription.charged", {
        ...event,
        payload: {
          ...event.payload,
          payment: { entity: { amount: 0, currency: "INR" } },
        },
      })
    ).toThrow(/catalog evidence/)
  })

  it("rejects underpaid Local license fulfillment", () => {
    expect(() =>
      resolveRazorpayCatalogEvent("payment_link.paid", {
        payload: {
          payment_link: { entity: { notes: { productId: "individual_launch" } } },
          payment: {
            entity: {
              amount: 1,
              currency: "INR",
              notes: { productId: "individual_launch" },
            },
          },
        },
      })
    ).toThrow(/catalog evidence/)
  })
})
