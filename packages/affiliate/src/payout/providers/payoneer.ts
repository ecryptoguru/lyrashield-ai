/**
 * Payoneer Enterprise Mass Payouts API provider — Global affiliates.
 *
 * Idempotent.
 * Docs: https://developer.payoneer.com/
 */

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

      void payoutId
      void amount
      void currency
      return { success: false, error: "Payoneer partnership API access is not approved" }
    },
  }
}
