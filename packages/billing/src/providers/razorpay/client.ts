/**
 * Razorpay SDK client wrapper.
 *
 * Uses the `razorpay` npm package for Razorpay API interactions.
 * Credentials are read from RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.
 */

import Razorpay from "razorpay"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

let clientInstance: Razorpay | null = null

/**
 * Get the Razorpay client. Returns null if credentials are not configured.
 */
export function getRazorpayClient(): Razorpay | null {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    logger.warn("Razorpay credentials not configured — client unavailable")
    return null
  }

  if (!clientInstance) {
    clientInstance = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    })
  }

  return clientInstance
}

/**
 * Create a Razorpay subscription.
 *
 * @returns The subscription ID, or null if Razorpay is not configured.
 */
export async function createRazorpaySubscription(params: {
  planId: string
  customerId?: string
  totalCount?: number
  notes?: Record<string, string>
}): Promise<string | null> {
  const client = getRazorpayClient()
  if (!client) return null

  try {
    const subscription = await client.subscriptions.create({
      plan_id: params.planId,
      customer_notify: 1,
      quantity: 1,
      total_count: params.totalCount ?? 12,
      notes: params.notes ?? {},
    })

    return subscription.id
  } catch (error) {
    logger.error("Failed to create Razorpay subscription", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Create a Razorpay one-time payment link for minute pack purchases.
 *
 * @returns The payment link URL or payment ID.
 */
export async function createRazorpayPaymentLink(params: {
  amount: number // in paise (1 INR = 100 paise)
  description: string
  notes?: Record<string, string>
  callbackUrl: string
}): Promise<{ id: string; url: string } | null> {
  const client = getRazorpayClient()
  if (!client) return null

  try {
    const paymentLink = await (client as unknown as {
      paymentLink: {
        create: (params: {
          amount: number
          currency: string
          description: string
          notes?: Record<string, string>
          callback_url: string
          callback_method: string
        }) => Promise<{ id: string; short_url: string }>
      }
    }).paymentLink.create({
      amount: params.amount,
      currency: "INR",
      description: params.description,
      notes: params.notes ?? {},
      callback_url: params.callbackUrl,
      callback_method: "get",
    })

    return { id: paymentLink.id, url: paymentLink.short_url }
  } catch (error) {
    logger.error("Failed to create Razorpay payment link", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Cancel a Razorpay subscription.
 */
export async function cancelRazorpaySubscription(
  subscriptionId: string
): Promise<boolean> {
  const client = getRazorpayClient()
  if (!client) return false

  try {
    await client.subscriptions.cancel(subscriptionId)
    return true
  } catch (error) {
    logger.error("Failed to cancel Razorpay subscription", {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Fetch a Razorpay subscription by ID.
 */
export async function getRazorpaySubscription(
  subscriptionId: string
): Promise<Record<string, unknown> | null> {
  const client = getRazorpayClient()
  if (!client) return null

  try {
    const subscription = await client.subscriptions.fetch(subscriptionId)
    return subscription as unknown as Record<string, unknown>
  } catch (error) {
    logger.error("Failed to fetch Razorpay subscription", {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
