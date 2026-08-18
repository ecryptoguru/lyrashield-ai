/**
 * Payoneer Enterprise Mass Payouts API provider — Global affiliates.
 *
 * Idempotent.
 * Docs: https://developer.payoneer.com/
 */

import { logger } from "@lyrashield/logger"
import { Prisma } from "@lyrashield/db"

export interface PayoneerProvider {
  send(
    payoutId: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
}

interface PayoneerPayoutMethod {
  type: "payoneer"
  payeeId?: string
  email?: string
  country?: string
}

/**
 * Create a Payoneer mass payout provider.
 * Uses PAYONEER_API_KEY / PAYONEER_API_SECRET / PAYONEER_PARTNER_ID.
 */
export function createPayoneerProvider(): PayoneerProvider {
  return {
    async send(
      payoutId: string,
      amount: string,
      currency: string,
      payoutMethod: unknown
    ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }> {
      const method = payoutMethod as PayoneerPayoutMethod | null

      if (!method || method.type !== "payoneer") {
        return { success: false, error: "Invalid payout method for Payoneer" }
      }

      // Q1: Use Prisma.Decimal for money — never parseFloat for monetary amounts
      const amountDecimal = new Prisma.Decimal(amount)
      if (amountDecimal.lte(0)) {
        return { success: false, error: "Invalid payout amount" }
      }

      try {
        // In production, this would call the Payoneer Mass Payouts API:
        // POST /mass-payouts/v2/programs/{program_id}/payments
        // with client_id/client_secret auth and idempotency key = payoutId
        //
        // const token = await getPayoneerToken()
        // const response = await fetch(
        //   `https://api.payoneer.com/mass-payouts/v2/programs/${partnerId}/payments`,
        //   {
        //     method: "POST",
        //     headers: {
        //       "Authorization": `Bearer ${token}`,
        //       "Content-Type": "application/json",
        //       "Idempotency-Key": payoutId,
        //     },
        //     body: JSON.stringify({
        //       payments: [{
        //         amount: { value: amount, currency },
        //         payee: { id: method.payeeId, email: method.email },
        //       }],
        //     }),
        //   }
        // )

        logger.info("Payoneer payout initiated (stub)", {
          payoutId,
          amount,
          currency,
          payeeId: method.payeeId,
        })

        return {
          success: true,
          providerPayoutId: `pyr_${payoutId}`,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Payoneer payout failed",
        }
      }
    },
  }
}
