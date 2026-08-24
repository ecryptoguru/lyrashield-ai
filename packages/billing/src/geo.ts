/**
 * GeoIP routing for payment providers.
 *
 * Determines whether a workspace should use Polar (USD, global) or
 * Razorpay (INR, India). Production remains USD until an authenticated
 * ingress-owned country signal exists; client request headers are not one.
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
export function resolveRegion(_request: Request, restrictedStagingAccess = false): BillingRegion {
  if (
    restrictedStagingAccess &&
    env.BILLING_STAGING_ADMISSION === "restricted" &&
    billingStagingConfigError(env) === null &&
    (env.BILLING_STAGING_REGION === "usd" || env.BILLING_STAGING_REGION === "inr")
  ) {
    return env.BILLING_STAGING_REGION
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
 * currency arbitrage. The region is determined solely by a validated,
 * session-bound staging override or the fail-closed USD default.
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
