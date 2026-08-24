import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "@lyrashield/config"

export type QuoteKind = "pack" | "local"

export interface BillingQuote {
  provider: "razorpay"
  kind: QuoteKind
  workspaceId: string
  catalogKey: string
  amountMinor: number
  currency: "INR"
}

export class BillingQuoteConfigError extends Error {
  constructor() {
    super("Billing quote signing is not configured")
    this.name = "BillingQuoteConfigError"
  }
}

function quoteSecret(): string {
  const secret = env.LYRASHIELD_INTERNAL_API_KEY?.trim()
  if (!secret) throw new BillingQuoteConfigError()
  return secret
}

function canonicalQuote(quote: BillingQuote): string {
  return [
    quote.provider,
    quote.kind,
    quote.workspaceId,
    quote.catalogKey,
    String(quote.amountMinor),
    quote.currency,
  ].join("|")
}

export function signBillingQuote(quote: BillingQuote): string {
  return createHmac("sha256", quoteSecret()).update(canonicalQuote(quote)).digest("hex")
}

export function billingQuoteNotes(quote: BillingQuote): Record<string, string> {
  return {
    quotedAmountMinor: String(quote.amountMinor),
    quoteSignature: signBillingQuote(quote),
  }
}

export function verifyBillingQuote(
  quote: BillingQuote,
  notes: Record<string, unknown>,
  paidAmountMinor: number
): boolean {
  const quotedRaw = notes.quotedAmountMinor
  const signature = notes.quoteSignature
  if (typeof quotedRaw !== "string" || !/^\d+$/.test(quotedRaw)) return false
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false
  const quotedAmount = Number(quotedRaw)
  if (!Number.isSafeInteger(quotedAmount) || quotedAmount !== quote.amountMinor) return false
  if (paidAmountMinor !== quotedAmount) return false
  const expected = Buffer.from(signBillingQuote(quote), "hex")
  const actual = Buffer.from(signature, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
