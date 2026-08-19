/**
 * Trolley provider — OPTIONAL at scale: tax automation.
 *
 * Stub for now. Trolley (formerly PaymentRails) provides mass payouts with
 * tax form automation. Enable when the affiliate program reaches scale.
 */

import { logger } from "@lyrashield/logger"

export interface TrolleyProvider {
  send(
    payoutId: string,
    amount: string,
    currency: string,
    payoutMethod: unknown
  ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }>
  /** Validate tax form status for a recipient. */
  validateTaxForm(recipientId: string): Promise<{ valid: boolean; formType?: string }>
}

/**
 * Create a Trolley payout provider (stub).
 */
export function createTrolleyProvider(): TrolleyProvider {
  return {
    async send(
      payoutId: string,
      amount: string,
      currency: string,
      _payoutMethod: unknown
    ): Promise<{ success: boolean; providerPayoutId?: string; error?: string }> {
      logger.info("Trolley payout initiated (stub)", { payoutId, amount, currency })

      // Stub — not yet implemented
      return {
        success: false,
        error: "Trolley provider not yet configured. Use RazorpayX or Payoneer.",
      }
    },

    async validateTaxForm(recipientId: string): Promise<{ valid: boolean; formType?: string }> {
      logger.info("Trolley tax form validation (stub)", { recipientId })
      return { valid: false }
    },
  }
}
