/**
 * GeoIP routing for payment providers.
 *
 * Determines whether a workspace should use Polar (USD, global) or
 * Razorpay (INR, India) based on the client IP address.
 *
 * Uses the `cf-connecting-ip` header (set by Cloudflare) by default,
 * with a manual override via the `BILLING_GEO_IP_HEADER` env var.
 *
 * Isolated billing staging may select an explicit server-side region only
 * after the request proves its restricted staging session.
 */

import { billingStagingConfigError, env } from "@lyrashield/config"

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
 *
 * A-L08: Only trust geo headers from a verified proxy chain. If
 * TRUSTED_PROXY_IP_HEADER is not configured, fall back to USD to prevent
 * header spoofing from untrusted sources.
 */
export function resolveRegion(request: Request, restrictedStagingAccess = false): BillingRegion {
  if (
    restrictedStagingAccess &&
    env.BILLING_STAGING_ADMISSION === "restricted" &&
    billingStagingConfigError(env) === null &&
    (env.BILLING_STAGING_REGION === "usd" || env.BILLING_STAGING_REGION === "inr")
  ) {
    return env.BILLING_STAGING_REGION
  }
  // A-L08: Only trust the cf-ipcountry header if a trusted proxy is configured.
  // Without a trusted proxy, any client can set this header and spoof their
  // country to get INR pricing (which may be cheaper).
  const trustedProxyHeader = env.TRUSTED_PROXY_IP_HEADER
  if (!trustedProxyHeader) {
    // No trusted proxy configured — fall back to USD to prevent spoofing
    return "usd"
  }

  // Verify the request came through the trusted proxy
  const proxyIp = request.headers.get(trustedProxyHeader.toLowerCase())
  if (!proxyIp) {
    // Request didn't come through the trusted proxy — fall back to USD
    return "usd"
  }

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
 * Resolve the provider and region from a request.
 *
 * A-L04: The client-supplied region override has been removed to prevent
 * currency arbitrage. The region is determined solely by the server-side
 * geo routing, which uses trusted proxy headers only.
 *
 * @param request - The incoming HTTP request
 */
export function resolveProvider(
  request: Request,
  restrictedStagingAccess = false
): {
  region: BillingRegion
  provider: BillingProvider
} {
  const region = resolveRegion(request, restrictedStagingAccess)
  return { region, provider: regionToProvider(region) }
}

/**
 * Get the client IP from the request using the configured header.
 */
export function getClientIp(request: Request): string | null {
  const headerName = env.BILLING_GEO_IP_HEADER || DEFAULT_GEO_IP_HEADER
  return request.headers.get(headerName)
}
