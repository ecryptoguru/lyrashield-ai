import "server-only"
import { getBillingAdmission, type BillingProvider } from "@lyrashield/billing"
import { apiError } from "./api-response"

export function paymentsUnavailableError(): Response {
  return apiError(
    "PAYMENTS_UNAVAILABLE",
    "Payments are temporarily unavailable. Please try again later.",
    503
  )
}

export function billingAdmissionError(
  provider: BillingProvider,
  workspaceId: string
): Response | null {
  return getBillingAdmission(provider, workspaceId).allowed ? null : paymentsUnavailableError()
}
