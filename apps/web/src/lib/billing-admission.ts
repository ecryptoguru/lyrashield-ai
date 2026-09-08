import "server-only"
import {
  getBillingAdmission,
  getLocalBillingAdmission,
  resolveProvider,
  type BillingProvider,
} from "@lyrashield/billing"
import { apiError } from "./api-response"

export function getRequestBillingAdmission(
  provider: BillingProvider,
  workspaceId: string,
  _request: Request
) {
  return getBillingAdmission(provider, workspaceId)
}

export function getRequestLocalBillingAdmission(provider: BillingProvider, _request: Request) {
  return getLocalBillingAdmission(provider)
}

export function resolveRequestBillingProvider(request: Request) {
  return resolveProvider(request)
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
