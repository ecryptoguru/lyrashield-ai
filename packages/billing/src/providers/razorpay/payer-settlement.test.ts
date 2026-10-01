import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Settlement proof for payer-bound Razorpay pack quotes (W0.1).
 *
 * Unlike payment-path.test.ts (which mocks the catalog module), this suite
 * keeps the REAL catalog verifier and the REAL quote producer/signer. Only
 * the ledger write (creditTopUp) and unrelated adapters are mocked; the
 * ledger replicates MinutePack's actual idempotency contract —
 * @@unique([workspaceId, externalId]) — as an in-memory disposable ledger.
 * (No disposable Postgres is available in this environment; the DB-backed
 * integration suites are env-skipped separately.)
 */
const envState = vi.hoisted(() => ({
  LYRASHIELD_INTERNAL_API_KEY: "test-internal-quote-secret",
}))
vi.mock("@lyrashield/config", () => ({ env: envState }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock("../../sync", () => ({ syncSubscription: vi.fn(), downgradeToFree: vi.fn() }))
vi.mock("../../usage/refund", () => ({ reverseRefund: vi.fn() }))
// Keep @lyrashield/db out of the module graph (license-fulfillment pulls the
// real Prisma client); the adapter path under test never reaches it.
vi.mock("../../license-fulfillment", () => ({
  issueLicenseForProviderOrder: vi.fn(),
  parseLocalProductIds: () => ({}),
}))

const ledger = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<Record<string, unknown>>,
}))
vi.mock("../../usage/packs", () => ({
  creditTopUp: vi.fn(async (input: Record<string, unknown>) => {
    ledger.calls.push(input)
    const key = `${input.workspaceId}:${input.externalId}`
    const existing = ledger.rows.get(key)
    if (existing) {
      // Real contract: replaying (workspaceId, externalId) is a no-op.
      return {
        created: false,
        minutes: existing.minutes,
        packId: existing.id,
        expiresAt: existing.expiresAt,
      }
    }
    const row = { id: `pack_${ledger.rows.size + 1}`, ...input }
    ledger.rows.set(key, row)
    return {
      created: true,
      minutes: input.minutes,
      packId: row.id,
      expiresAt: input.expiresAt,
    }
  }),
}))

import { processRazorpayEvent } from "./adapter"
import { resolveRazorpayEventIdentity, type RazorpayWebhookEvent } from "./webhooks"
import { billingQuoteNotes } from "../../provider-quote"
import { creditTopUp } from "../../usage/packs"

const WORKSPACE = "workspace_1"
const ACCOUNT = "acct_buyer_1"
const PACK_AMOUNT = 150_000
const NOW_S = Math.floor(Date.now() / 1000)

/** Exact note shape emitted by apps/web/src/app/api/billing/topup/route.ts. */
function routePackNotes(
  params: {
    workspaceId?: string
    accountId?: string
    packId?: string
    amountMinor?: number
  } = {}
) {
  const workspaceId = params.workspaceId ?? WORKSPACE
  const accountId = params.accountId ?? ACCOUNT
  const packId = params.packId ?? "pack_100"
  const amountMinor = params.amountMinor ?? PACK_AMOUNT
  return {
    workspaceId,
    accountId,
    packId,
    ...billingQuoteNotes({
      provider: "razorpay",
      kind: "pack",
      workspaceId,
      accountId,
      catalogKey: packId,
      amountMinor,
      currency: "INR",
    }),
  }
}

function capturedEvent(paymentId: string, notes: Record<string, unknown>): RazorpayWebhookEvent {
  const event: RazorpayWebhookEvent = {
    event: "payment.captured",
    created_at: NOW_S,
    payload: {
      payment: {
        entity: { id: paymentId, amount: PACK_AMOUNT, currency: "INR", notes },
      },
    },
  }
  return event
}

beforeEach(() => {
  ledger.rows.clear()
  ledger.calls.length = 0
  vi.mocked(creditTopUp).mockClear()
})

describe("payment.captured settlement — payer-bound exactly-once credit", () => {
  it("credits the account bound into the signed quote, not a caller-controlled payer", async () => {
    const result = await processRazorpayEvent(capturedEvent("pay_SETTLE_1", routePackNotes()))

    expect(result).toEqual({
      handled: true,
      action: "payment.captured.credited",
      workspaceId: WORKSPACE,
    })
    expect(creditTopUp).toHaveBeenCalledTimes(1)
    expect(ledger.calls[0]).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      provider: "razorpay",
      externalId: "pay_SETTLE_1",
    })
    expect(ledger.rows.size).toBe(1)
    expect([...ledger.rows.values()][0]).toMatchObject({ accountId: ACCOUNT })
  })

  it("credits exactly once across duplicate deliveries and distinct delivery ids sharing one payment id", async () => {
    const event = capturedEvent("pay_SETTLE_DUP", routePackNotes())

    // Provider redelivery of the same logical event — same payment id. The
    // ingress dedupes by WebhookEvent.externalId (delivery id / derived
    // digest); the ledger additionally dedupes by payment externalId, which
    // is what protects credit when two DIFFERENT delivery ids share one
    // payment id.
    const firstDelivery = resolveRazorpayEventIdentity(event, "evt_delivery_A")
    const secondDelivery = resolveRazorpayEventIdentity(event, "evt_delivery_B")
    expect(firstDelivery?.externalId).not.toBe(secondDelivery?.externalId)

    const r1 = await processRazorpayEvent(event)
    const r2 = await processRazorpayEvent(event)
    const r3 = await processRazorpayEvent(event)

    for (const r of [r1, r2, r3]) expect(r.action).toBe("payment.captured.credited")
    // The handler may run once per claimed delivery, but the ledger grants
    // the pack exactly once for the payment id.
    expect(creditTopUp).toHaveBeenCalledTimes(3)
    expect(ledger.rows.size).toBe(1)
    const pack = [...ledger.rows.values()][0]!
    expect(pack).toMatchObject({ accountId: ACCOUNT, externalId: "pay_SETTLE_DUP" })
  })

  it("never credits when the accountId note is grafted onto another payer's quote", async () => {
    const grafted = { ...routePackNotes(), accountId: "acct_attacker" }
    await expect(processRazorpayEvent(capturedEvent("pay_GRAFT", grafted))).rejects.toThrow()
    expect(creditTopUp).not.toHaveBeenCalled()
    expect(ledger.rows.size).toBe(0)
  })

  it("never credits when the accountId note is missing", async () => {
    const notes: Record<string, unknown> = { ...routePackNotes() }
    delete notes.accountId
    await expect(processRazorpayEvent(capturedEvent("pay_NOACCT", notes))).rejects.toThrow()
    expect(creditTopUp).not.toHaveBeenCalled()
    expect(ledger.rows.size).toBe(0)
  })
})

describe("payment_link.paid — receipt without pack credit (documented distinction)", () => {
  it("records the payer-bound pack link but leaves payment.captured as the sole grant", async () => {
    const event: RazorpayWebhookEvent = {
      event: "payment_link.paid",
      created_at: NOW_S,
      payload: {
        payment_link: { entity: { id: "plink_PACK_1", notes: routePackNotes() } },
        payment: {
          entity: {
            id: "pay_LINK_1",
            amount: PACK_AMOUNT,
            currency: "INR",
            // Razorpay copies payment-link notes onto the payment entity.
            notes: routePackNotes(),
          },
        },
      },
    }

    const result = await processRazorpayEvent(event)

    expect(result).toEqual({
      handled: true,
      action: "payment_link.paid.received",
      workspaceId: null,
    })
    expect(creditTopUp).not.toHaveBeenCalled()
    expect(ledger.rows.size).toBe(0)
  })
})
