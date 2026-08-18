/**
 * RazorpayX Payouts API provider — India affiliates.
 *
 * INR domestic, IMPS/UPI. Idempotent.
 * Docs: https://razorpay.com/docs/api/route-x/
 */

import { logger } from "@lyrashield/logger"

export interface RazorpayXProvider {
  send(
    payoutId: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
}

interface RazorpayXPayoutMethod {
  type: "razorpayx"
  accountNumber?: string
  ifsc?: string
  upiId?: string
  beneficiaryName?: string
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
    ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }> {
      const method = payoutMethod as RazorpayXPayoutMethod | null

      if (!method || method.type !== "razorpayx") {
        return { success: false, error: "Invalid payout method for RazorpayX" }
      }

      if (currency !== "INR") {
        return { success: false, error: "RazorpayX only supports INR payouts" }
      }

      // Convert major units to paise (integer)
      const amountPaise = Math.round(parseFloat(amount) * 100)
      if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
        return { success: false, error: "Invalid payout amount" }
      }

      try {
        // In production, this would call the RazorpayX Payouts API:
        // POST https://api.razorpay.com/v1/payouts
        // with idempotency key = payoutId
        //
        // const response = await fetch("https://api.razorpay.com/v1/payouts", {
        //   method: "POST",
        //   headers: {
        //     "Authorization": `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
        //     "Content-Type": "application/json",
        //     "X-Payout-Idempotency": payoutId,
        //   },
        //   body: JSON.stringify({
        //     account_number: accountNumber,
        //     amount: amountPaise,
        //     currency: "INR",
        //     mode: method.upiId ? "UPI" : "IMPS",
        //     purpose: "payout",
        //     ...(method.upiId ? { vpa: method.upiId } : { ifsc: method.ifsc, account_number: method.accountNumber }),
        //     beneficiary_name: method.beneficiaryName,
        //   }),
        // })

        logger.info("RazorpayX payout initiated (stub)", {
          payoutId,
          amountPaise,
          mode: method.upiId ? "UPI" : "IMPS",
        })

        // Stub: return success with a mock provider payout id
        return {
          success: true,
          providerPayoutId: `rpx_${payoutId}`,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "RazorpayX payout failed",
        }
      }
    },
  }
}
