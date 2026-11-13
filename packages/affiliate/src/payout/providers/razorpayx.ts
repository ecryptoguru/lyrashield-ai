/**
 * RazorpayX Payouts API provider — India affiliates.
 *
 * INR domestic, IMPS/UPI. Idempotent.
 * Docs: https://razorpay.com/docs/api/route-x/
 */

import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"

const PAYOUT_REQUEST_TIMEOUT_MS = 30_000
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024
const REJECTED_STATUSES = new Set(["rejected", "failed", "cancelled", "reversed"])
const PAYOUT_STATUSES = new Set([
  ...REJECTED_STATUSES,
  "processed",
  "queued",
  "pending",
  "processing",
  "scheduled",
])

type PayoutStatus =
  | "rejected"
  | "failed"
  | "cancelled"
  | "reversed"
  | "processed"
  | "queued"
  | "pending"
  | "processing"
  | "scheduled"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsePayoutMethod(value: unknown): RazorpayXPayoutMethod | null {
  if (!isRecord(value) || value.type !== "razorpayx" || !isFundAccountId(value.fundAccountId)) {
    return null
  }
  return { type: "razorpayx", fundAccountId: value.fundAccountId }
}

function isPayoutResponse(value: unknown): value is { id: string; status: PayoutStatus } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.status === "string" &&
    PAYOUT_STATUSES.has(value.status)
  )
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }

  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    return null
  }
}

export interface RazorpayXProvider {
  send(
    payoutId: string,
    idempotencyKey: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ): Promise<{
    success: boolean
    pending?: boolean
    rejected?: boolean
    providerPayoutId?: string
    error?: string
  }>
}

interface RazorpayXPayoutMethod {
  type: "razorpayx"
  fundAccountId?: string
  maskedDisplay?: string
}

function isFundAccountId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("fa_") || value.length <= 3) return false
  return [...value.slice(3)].every(
    (character) =>
      (character >= "0" && character <= "9") ||
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z")
  )
}

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9")
}

function toPaise(amount: string): number | null {
  const parts = amount.split(".")
  if (parts.length > 2 || !isDigits(parts[0] ?? "")) return null
  const fraction = parts[1] ?? ""
  if ((parts.length === 2 && !isDigits(fraction)) || fraction.length > 4) return null
  const paise = BigInt(parts[0]!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0")
  const discarded = fraction.slice(2)
  if (discarded && /[1-9]/.test(discarded)) return null
  return paise > 0n && paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null
}

/**
 * Create a RazorpayX payout provider.
 * Uses RAZORPAYX_API_KEY / RAZORPAYX_API_SECRET / RAZORPAYX_ACCOUNT_NUMBER.
 */
export function createRazorpayXProvider(): RazorpayXProvider {
  return {
    async send(
      payoutId: string,
      idempotencyKey: string,
      amount: string,
      currency: string,
      payoutMethod: unknown
    ): Promise<{
      success: boolean
      pending?: boolean
      rejected?: boolean
      providerPayoutId?: string
      error?: string
    }> {
      const method = parsePayoutMethod(payoutMethod)

      if (!method || method.type !== "razorpayx") {
        return { success: false, error: "Invalid payout method for RazorpayX" }
      }

      if (currency !== "INR") {
        return { success: false, error: "RazorpayX only supports INR payouts" }
      }

      const amountPaise = toPaise(amount)
      if (!amountPaise || !isFundAccountId(method.fundAccountId)) {
        return { success: false, error: "Invalid payout amount" }
      }

      try {
        if (!env.RAZORPAYX_API_KEY || !env.RAZORPAYX_API_SECRET || !env.RAZORPAYX_ACCOUNT_NUMBER) {
          return { success: false, error: "RazorpayX is not configured" }
        }
        const response = await fetch("https://api.razorpay.com/v1/payouts", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.RAZORPAYX_API_KEY}:${env.RAZORPAYX_API_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json",
            "X-Payout-Idempotency": idempotencyKey,
          },
          body: JSON.stringify({
            account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
            fund_account_id: method.fundAccountId,
            amount: amountPaise,
            currency: "INR",
            mode: "IMPS",
            purpose: "payout",
            queue_if_low_balance: false,
            reference_id: payoutId,
            narration: "LyraShield affiliate payout",
          }),
          signal: AbortSignal.timeout(PAYOUT_REQUEST_TIMEOUT_MS),
        })
        const parsedBody = await readBoundedJson(response)
        if (!isPayoutResponse(parsedBody)) {
          return { success: false, error: "RazorpayX outcome unconfirmed" }
        }
        const body = parsedBody
        if (!response.ok) {
          return {
            success: false,
            error: "RazorpayX outcome unconfirmed",
            providerPayoutId: body.id,
          }
        }
        if (REJECTED_STATUSES.has(body.status)) {
          return {
            success: false,
            rejected: true,
            providerPayoutId: body.id,
            error: "RazorpayX rejected the payout",
          }
        }
        logger.info("RazorpayX payout accepted", {
          payoutId,
          providerPayoutId: body.id,
          status: body.status,
        })
        if (body.status === "processed") return { success: true, providerPayoutId: body.id }
        if (["queued", "pending", "processing", "scheduled"].includes(body.status)) {
          return { success: false, pending: true, providerPayoutId: body.id }
        }
        return { success: false, error: "RazorpayX outcome unconfirmed", providerPayoutId: body.id }
      } catch {
        return {
          success: false,
          error: "RazorpayX outcome unconfirmed",
        }
      }
    },
  }
}
