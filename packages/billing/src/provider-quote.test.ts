import { beforeEach, describe, expect, it, vi } from "vitest"

// The quote secret must be mutable per test — `env` is read lazily inside
// `quoteSecret`, so a hoisted object keeps the missing-key case reachable.
const mocks = vi.hoisted(() => ({
  env: { LYRASHIELD_INTERNAL_API_KEY: "test-signing-key" as string | undefined },
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))

import {
  BillingQuoteConfigError,
  billingQuoteNotes,
  signBillingQuote,
  verifyBillingQuote,
  type BillingQuote,
} from "./provider-quote"

const quote: BillingQuote = {
  provider: "razorpay",
  kind: "pack",
  workspaceId: "ws-1",
  accountId: "acct-1",
  catalogKey: "pack_60",
  amountMinor: 5900,
  currency: "INR",
}

beforeEach(() => {
  mocks.env.LYRASHIELD_INTERNAL_API_KEY = "test-signing-key"
})

describe("billing quote signing", () => {
  it("round-trips a signed quote through the payment notes", () => {
    const notes = billingQuoteNotes(quote)
    expect(verifyBillingQuote(quote, notes, quote.amountMinor)).toBe(true)
  })

  it("is stable and bound to the account field", () => {
    const signed = signBillingQuote(quote)
    expect(signed).toMatch(/^[0-9a-f]{64}$/)
    expect(signBillingQuote(quote)).toBe(signed)
    // A quote without accountId must not verify against the account-bound one.
    const unbound: BillingQuote = { ...quote }
    delete unbound.accountId
    expect(signBillingQuote(unbound)).not.toBe(signed)
  })

  it("rejects a quote replayed for a different workspace, catalog item, or amount", () => {
    const notes = billingQuoteNotes(quote)
    for (const tampered of [
      { ...quote, workspaceId: "ws-2" },
      { ...quote, accountId: "acct-2" },
      { ...quote, catalogKey: "pack_240" },
      { ...quote, amountMinor: 100 },
      { ...quote, kind: "local" as const },
    ]) {
      expect(verifyBillingQuote(tampered, notes, tampered.amountMinor)).toBe(false)
    }
  })

  it("rejects a paid amount that differs from the quoted amount", () => {
    const notes = billingQuoteNotes(quote)
    expect(verifyBillingQuote(quote, notes, quote.amountMinor + 1)).toBe(false)
  })

  it("rejects missing or malformed note fields", () => {
    expect(verifyBillingQuote(quote, {}, quote.amountMinor)).toBe(false)
    expect(verifyBillingQuote(quote, { quotedAmountMinor: "5900" }, quote.amountMinor)).toBe(false)
    expect(
      verifyBillingQuote(
        quote,
        { quotedAmountMinor: "abc", quoteSignature: "f".repeat(64) },
        quote.amountMinor
      )
    ).toBe(false)
    expect(
      verifyBillingQuote(
        quote,
        { quotedAmountMinor: "5900", quoteSignature: "not-hex" },
        quote.amountMinor
      )
    ).toBe(false)
    // A wrong-but-well-formed signature fails the constant-time compare.
    expect(
      verifyBillingQuote(
        quote,
        { quotedAmountMinor: "5900", quoteSignature: "0".repeat(64) },
        quote.amountMinor
      )
    ).toBe(false)
  })

  it("fails closed when the signing key is absent or blank", () => {
    mocks.env.LYRASHIELD_INTERNAL_API_KEY = undefined
    expect(() => signBillingQuote(quote)).toThrow(BillingQuoteConfigError)
    mocks.env.LYRASHIELD_INTERNAL_API_KEY = "   "
    expect(() => signBillingQuote(quote)).toThrow(BillingQuoteConfigError)
  })
})
