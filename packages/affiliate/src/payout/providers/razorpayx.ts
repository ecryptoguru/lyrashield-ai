/**
 * RazorpayX Payouts API provider — India affiliates.
 *
 * INR domestic, IMPS/UPI. Idempotent.
 * Docs: https://razorpay.com/docs/api/route-x/
 */

import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"

export interface RazorpayXProvider {
  send(
    payoutId: string,
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
      const method = payoutMethod as RazorpayXPayoutMethod | null

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
            "X-Payout-Idempotency": payoutId,
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
        })
        const body = (await response.json().catch(() => null)) as {
          id?: string
          status?: string
        } | null
        const rejected = ["rejected", "failed", "cancelled", "reversed"].includes(
          body?.status ?? ""
        )
        if (rejected) {
          return { success: false, rejected: true, error: "RazorpayX rejected the payout" }
        }
        if (!response.ok || !body?.id)
          return { success: false, error: "RazorpayX outcome unconfirmed" }
        logger.info("RazorpayX payout accepted", {
          payoutId,
          providerPayoutId: body.id,
          status: body.status,
        })
        if (body.status === "processed") return { success: true, providerPayoutId: body.id }
        if (["queued", "pending", "processing", "scheduled"].includes(body.status ?? "")) {
          return { success: false, pending: true, providerPayoutId: body.id }
        }
        return { success: false, error: "RazorpayX outcome unconfirmed", providerPayoutId: body.id }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "RazorpayX payout failed",
        }
      }
    },
  }
}
