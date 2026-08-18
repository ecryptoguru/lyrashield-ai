/**
 * GeoIP routing for payment providers.
 *
 * Determines whether a workspace should use Polar (USD, global) or
 * Razorpay (INR, India) based on the client IP address.
 *
 * Uses the `cf-connecting-ip` header (set by Cloudflare) by default,
 * with a manual override via the `BILLING_GEO_IP_HEADER` env var.
 *
 * The routing decision can also be overridden by the client (e.g. a user
 * who wants to pay in USD despite being in India).
 */

import { env } from "@lyrashield/config"

export type BillingRegion = "usd" | "inr"
export type BillingProvider = "polar" | "razorpay"

/** Default header for extracting the client IP. */
const DEFAULT_GEO_IP_HEADER = "cf-connecting-ip"

/**
 * Simple IP-based geo routing.
 *
 * In production, this would use a GeoIP database (MaxMind, Cloudflare's
 * `cf-ipcountry` header, or similar). For now, we use the Cloudflare
 * `cf-ipcountry` header if available, falling back to USD (Polar).
 *
 * India (IN) → Razorpay (INR)
 * Everywhere else → Polar (USD)
 */
export function resolveRegion(request: Request): BillingRegion {
  // Check for country header (Cloudflare sets cf-ipcountry)
  const countryCode = request.headers.get("cf-ipcountry")
  if (countryCode && countryCode.toUpperCase() === "IN") {
    return "inr"
  }

  // Fallback: check the geo IP header
  const headerName = env.BILLING_GEO_IP_HEADER || DEFAULT_GEO_IP_HEADER
  const ip = request.headers.get(headerName)
  if (ip) {
    // Basic check: if we have a GeoIP service, use it here.
    // For now, default to USD for all IPs.
  }

  return "usd"
}

/**
 * Map a billing region to a payment provider.
 */
export function regionToProvider(region: BillingRegion): BillingProvider {
  return region === "inr" ? "razorpay" : "polar"
}

/**
 * Resolve the provider and region from a request, with optional manual override.
 *
 * @param request - The incoming HTTP request
 * @param override - Optional manual region override from the client
 */
export function resolveProvider(
  request: Request,
  override?: BillingRegion
): { region: BillingRegion; provider: BillingProvider } {
  const region = override ?? resolveRegion(request)
  return { region, provider: regionToProvider(region) }
}

/**
 * Get the client IP from the request using the configured header.
 */
export function getClientIp(request: Request): string | null {
  const headerName = env.BILLING_GEO_IP_HEADER || DEFAULT_GEO_IP_HEADER
  return request.headers.get(headerName)
}
