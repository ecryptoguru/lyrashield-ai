/**
 * BriskPe provider — RBI-native fallback when Payoneer partnership
 * is not yet approved.
 *
 * BriskPe is an RBI-compliant cross-border payout provider for India.
 * Idempotent.
 */

import { logger } from "@lyrashield/logger"

export interface BriskpeProvider {
  send(
    payoutId: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
}

interface BriskpePayoutMethod {
  type: "briskpe"
  accountNumber?: string
  ifsc?: string
  beneficiaryName?: string
  country?: string
}

/**
 * Create a BriskPe payout provider.
 * Fallback for global payouts when Payoneer is not available.
 */
export function createBriskpeProvider(): BriskpeProvider {
  return {
    async send(
      payoutId: string,
      amount: string,
      currency: string,
      payoutMethod: unknown
    ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }> {
      const method = payoutMethod as BriskpePayoutMethod | null

      if (!method || method.type !== "briskpe") {
        return { success: false, error: "Invalid payout method for BriskPe" }
      }

      const amountNum = parseFloat(amount)
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        return { success: false, error: "Invalid payout amount" }
      }

      try {
        // In production, this would call the BriskPe API with idempotency key
        logger.info("BriskPe payout initiated (stub)", {
          payoutId,
          amount,
          currency,
        })

        return {
          success: true,
          providerPayoutId: `bp_${payoutId}`,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "BriskPe payout failed",
        }
      }
    },
  }
}
