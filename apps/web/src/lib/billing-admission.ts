import "server-only"
import {
  getBillingAdmission,
  getLocalBillingAdmission,
  resolveProvider,
  type BillingProvider,
} from "@lyrashield/billing"
import { apiError } from "./api-response"
import { hasBillingStagingAccess } from "./billing-staging-access"

export function getRequestBillingAdmission(
  provider: BillingProvider,
  workspaceId: string,
  request: Request
) {
  return getBillingAdmission(provider, workspaceId, hasBillingStagingAccess(request))
}

export function getRequestLocalBillingAdmission(provider: BillingProvider, request: Request) {
  return getLocalBillingAdmission(provider, hasBillingStagingAccess(request))
}

export function resolveRequestBillingProvider(request: Request) {
  return resolveProvider(request, hasBillingStagingAccess(request))
}

export function paymentsUnavailableError(): Response {
  return apiError(
    "PAYMENTS_UNAVAILABLE",
    "Payments are temporarily unavailable. Please try again later.",
    503
  )
}

export function billingAdmissionError(
  provider: BillingProvider,
  workspaceId: string,
  request: Request
): Response | null {
  return getRequestBillingAdmission(provider, workspaceId, request).allowed
    ? null
    : paymentsUnavailableError()
}

export function localBillingAdmissionError(
  provider: BillingProvider,
  request: Request
): Response | null {
  return getRequestLocalBillingAdmission(provider, request).allowed
    ? null
    : apiError("PAYMENTS_UNAVAILABLE", "Local purchases are temporarily unavailable.", 503)
}
