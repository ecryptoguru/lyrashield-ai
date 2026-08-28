/**
 * GeoIP routing for payment providers.
 *
 * Determines whether a workspace should use Polar (USD, global) or
 * Razorpay (INR, India). The app proxy accepts country only after validating
 * Cloudflare Authenticated Origin Pulls, then writes its private header.
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
 * Client-controlled forwarding and country headers are not authenticated
 * evidence of region. Direct Azure ingress does not currently strip and
 * replace a country signal, so normal requests fail closed to USD.
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
  if (request.headers.get("x-lyrashield-trusted-country") === "IN") return "inr"
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
 * A-L04: Client-controlled region and forwarding headers are ignored. The
 * region is determined only by proxy-authenticated country or a validated,
 * session-bound staging override.
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
