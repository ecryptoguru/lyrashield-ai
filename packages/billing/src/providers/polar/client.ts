/**
 * Polar SDK client wrapper.
 *
 * Uses @polar-sh/sdk for Polar API interactions.
 * The access token is read from POLAR_ACCESS_TOKEN.
 */

import { Polar } from "@polar-sh/sdk"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

let clientInstance: Polar | null = null

/**
 * Get the Polar SDK client. Returns null if POLAR_ACCESS_TOKEN is not configured.
 */
export function getPolarClient(): Polar | null {
  if (!env.POLAR_ACCESS_TOKEN) {
    logger.warn("POLAR_ACCESS_TOKEN not configured — Polar client unavailable")
    return null
  }

  if (!clientInstance) {
    clientInstance = new Polar({
      accessToken: env.POLAR_ACCESS_TOKEN,
      server: env.POLAR_ENVIRONMENT,
    })
  }

  return clientInstance
}

/**
 * Create a Polar hosted checkout session for a subscription.
 *
 * @returns The checkout URL, or null if Polar is not configured.
 */
export async function createPolarCheckout(params: {
  productId: string
  successUrl: string
  customerId?: string
  metadata?: Record<string, string>
}): Promise<string | null> {
  const client = getPolarClient()
  if (!client) return null

  try {
    const checkout = await client.checkouts.create({
      products: [params.productId],
      successUrl: params.successUrl,
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    })

    return checkout.url
  } catch (error) {
    logger.error("Failed to create Polar checkout", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Create a Polar hosted checkout for a one-time product (minute pack).
 */
export async function createPolarOneTimeCheckout(params: {
  productId: string
  successUrl: string
  metadata?: Record<string, string>
}): Promise<string | null> {
  const client = getPolarClient()
  if (!client) return null

  try {
    const checkout = await client.checkouts.create({
      products: [params.productId],
      successUrl: params.successUrl,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    })

    return checkout.url
  } catch (error) {
    logger.error("Failed to create Polar one-time checkout", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Get the Polar customer portal URL for subscription management.
 */
export async function getPolarPortalUrl(params: { customerId: string }): Promise<string | null> {
  const client = getPolarClient()
  if (!client) return null

  try {
    // Polar customer portal API
    const portal = await (
      client as unknown as {
        customerPortal: {
          sessions: { create: (params: { customerId: string }) => Promise<{ url: string }> }
        }
      }
    ).customerPortal.sessions.create({
      customerId: params.customerId,
    })

    return portal.url
  } catch (error) {
    logger.error("Failed to get Polar portal URL", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
