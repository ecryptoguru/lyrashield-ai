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
import { billingQuoteNotes, verifyBillingQuote } from "./provider-quote"

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
        subtotal_amount: 6500,
        total_amount: 6500,
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

  it("rejects inherited object keys as Local SKUs", () => {
    envState.POLAR_LOCAL_PRODUCT_IDS = JSON.stringify({ toString: "polar-local-prototype" })
    expect(() =>
      resolvePolarCatalogEvent("subscription.active", {
        product_id: "polar-local-prototype",
        metadata: { sku: "toString" },
      })
    ).toThrow(/catalog evidence/)
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
      accountId: "account-1",
      packId: "pack_100",
      ...quoteNotes({
        kind: "pack",
        workspaceId: "workspace-1",
        catalogKey: "pack_100",
        amountMinor,
        accountId: "account-1",
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
      accountId: "account-1",
      packId: "pack_100",
      ...quoteNotes({
        kind: "pack",
        workspaceId: "workspace-1",
        catalogKey: "pack_100",
        amountMinor: packAmount,
        accountId: "account-1",
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

  describe("payer-bound pack quotes (W0.1)", () => {
    const WORKSPACE = "workspace_1"
    const ACCOUNT = "acct_buyer_1"
    const PACK_AMOUNT = 150_000

    /**
     * Exact note shape emitted by apps/web/src/app/api/billing/topup/route.ts:
     * `{ workspaceId, accountId, packId }` metadata merged with
     * `billingQuoteNotes(...)` over the account-bound quote. Razorpay copies
     * payment-link notes onto the captured payment entity, so both
     * `payment.captured` and `payment_link.paid` deliver this same shape.
     */
    function routePackNotes(overrides: {
      workspaceId?: string
      accountId?: string | null
      packId?: string
      amountMinor?: number
      signAccountId?: string | null
      signWorkspaceId?: string
      signCatalogKey?: string
      signAmountMinor?: number
      extra?: Record<string, string>
    } = {}) {
      const workspaceId = overrides.workspaceId ?? WORKSPACE
      const accountId = overrides.accountId === undefined ? ACCOUNT : overrides.accountId
      const packId = overrides.packId ?? "pack_100"
      const amountMinor = overrides.amountMinor ?? PACK_AMOUNT
      const quote = {
        provider: "razorpay" as const,
        kind: "pack" as const,
        workspaceId: overrides.signWorkspaceId ?? workspaceId,
        ...(overrides.signAccountId === null
          ? {}
          : { accountId: overrides.signAccountId ?? accountId ?? undefined }),
        catalogKey: overrides.signCatalogKey ?? packId,
        amountMinor: overrides.signAmountMinor ?? amountMinor,
        currency: "INR" as const,
      }
      return {
        workspaceId,
        ...(accountId === null ? {} : { accountId }),
        packId,
        ...billingQuoteNotes(quote),
        ...overrides.extra,
      }
    }

    function capturedEvent(notes: Record<string, unknown>, amount = PACK_AMOUNT) {
      return {
        payload: {
          payment: { entity: { id: "pay_1", amount, currency: "INR", notes } },
        },
      }
    }

    function linkPaidEvent(
      paymentNotes: Record<string, unknown>,
      linkNotes: Record<string, unknown> = {},
      amount = PACK_AMOUNT
    ) {
      return {
        payload: {
          payment_link: { entity: { id: "plink_1", notes: linkNotes } },
          payment: { entity: { id: "pay_1", amount, currency: "INR", notes: paymentNotes } },
        },
      }
    }

    it("accepts the real top-up route metadata shape on payment.captured", () => {
      expect(
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(routePackNotes()))
      ).toEqual({ kind: "pack", packId: "pack_100" })
    })

    it("accepts the same payer-bound quote on payment_link.paid", () => {
      const notes = routePackNotes()
      // Razorpay copies payment-link notes onto the payment entity; either
      // carrier must resolve to the same bound quote.
      expect(
        resolveRazorpayCatalogEvent("payment_link.paid", linkPaidEvent(notes))
      ).toEqual({ kind: "pack", packId: "pack_100" })
      expect(
        resolveRazorpayCatalogEvent("payment_link.paid", linkPaidEvent({}, notes))
      ).toEqual({ kind: "pack", packId: "pack_100" })
    })

    it("verifies the quote signature against the credited account directly", () => {
      const notes = routePackNotes()
      const base = {
        provider: "razorpay" as const,
        kind: "pack" as const,
        workspaceId: WORKSPACE,
        catalogKey: "pack_100",
        amountMinor: PACK_AMOUNT,
        currency: "INR" as const,
      }
      expect(verifyBillingQuote({ ...base, accountId: ACCOUNT }, notes, PACK_AMOUNT)).toBe(true)
      // The payer is part of the signed canonical quote — any other account
      // reconstruction must fail.
      expect(verifyBillingQuote({ ...base, accountId: "acct_other" }, notes, PACK_AMOUNT)).toBe(
        false
      )
      expect(verifyBillingQuote(base, notes, PACK_AMOUNT)).toBe(false)
    })

    it("rejects a pack quote that carries no account binding", () => {
      // Account-free signed quote (pre-account-binding shape): without the
      // accountId note the adapter has no authenticated payer to credit.
      const unsignedAccount = routePackNotes({ accountId: null, signAccountId: null })
      expect(() =>
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(unsignedAccount))
      ).toThrow(/catalog evidence/)
      expect(() =>
        resolveRazorpayCatalogEvent("payment_link.paid", linkPaidEvent(unsignedAccount))
      ).toThrow(/catalog evidence/)

      // Signed for the account but the accountId note stripped — must also fail.
      const stripped = routePackNotes({ accountId: null })
      expect(() =>
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(stripped))
      ).toThrow(/catalog evidence/)
    })

    it("rejects an accountId grafted onto another payer's signed quote", () => {
      // Note claims a different payer than the one bound into the signature.
      const grafted = routePackNotes({ accountId: "acct_attacker", signAccountId: ACCOUNT })
      expect(() =>
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(grafted))
      ).toThrow(/catalog evidence/)
      expect(() =>
        resolveRazorpayCatalogEvent("payment_link.paid", linkPaidEvent(grafted))
      ).toThrow(/catalog evidence/)
    })

    it("rejects a conflicting second account field across link and payment notes", () => {
      const notes = routePackNotes()
      expect(() =>
        resolveRazorpayCatalogEvent(
          "payment_link.paid",
          linkPaidEvent(notes, { accountId: "acct_conflicting" })
        )
      ).toThrow(/catalog evidence/)
      expect(() =>
        resolveRazorpayCatalogEvent(
          "payment_link.paid",
          linkPaidEvent({ accountId: "acct_conflicting" }, notes)
        )
      ).toThrow(/catalog evidence/)
    })

    it("rejects wrong workspace, catalog key, currency, and amount under a valid quote", () => {
      // Workspace claim differs from the signed workspace.
      expect(() =>
        resolveRazorpayCatalogEvent(
          "payment.captured",
          capturedEvent({ ...routePackNotes(), workspaceId: "workspace_other" })
        )
      ).toThrow(/catalog evidence/)

      // Catalog claim escalates beyond the signed pack.
      expect(() =>
        resolveRazorpayCatalogEvent(
          "payment.captured",
          capturedEvent({ ...routePackNotes(), packId: "pack_500" })
        )
      ).toThrow(/catalog evidence/)

      // Non-INR capture can never fulfill an INR quote.
      const usd = capturedEvent(routePackNotes())
      usd.payload.payment.entity.currency = "USD"
      expect(() => resolveRazorpayCatalogEvent("payment.captured", usd)).toThrow(
        /catalog evidence/
      )

      // Underpayment against a correctly signed quote.
      expect(() =>
        resolveRazorpayCatalogEvent(
          "payment.captured",
          capturedEvent(routePackNotes(), PACK_AMOUNT - 1)
        )
      ).toThrow(/catalog evidence/)
    })

    it("rejects a tampered quote signature", () => {
      const notes = routePackNotes({ extra: { quoteSignature: "0".repeat(64) } })
      expect(() =>
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(notes))
      ).toThrow(/catalog evidence/)
      const flipped = {
        ...routePackNotes(),
        quoteSignature: routePackNotes().quoteSignature.replace(/^./, "f"),
      }
      expect(() =>
        resolveRazorpayCatalogEvent("payment.captured", capturedEvent(flipped))
      ).toThrow(/catalog evidence/)
    })

    it("preserves account-free Local SKU quote compatibility", () => {
      const localAmount = 1_990_000
      const localNotes = {
        productId: "individual_launch",
        quoteWorkspaceId: "local-reference-1",
        ...billingQuoteNotes({
          provider: "razorpay",
          kind: "local",
          workspaceId: "local-reference-1",
          catalogKey: "individual_launch",
          amountMinor: localAmount,
          currency: "INR",
        }),
      }
      expect(
        resolveRazorpayCatalogEvent("payment_link.paid", {
          payload: {
            payment: {
              entity: { amount: localAmount, currency: "INR", notes: localNotes },
            },
          },
        })
      ).toEqual({ kind: "local", sku: "individual_launch" })
    })
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
