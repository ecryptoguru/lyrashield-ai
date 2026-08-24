import { billingStagingConfigError, env } from "@lyrashield/config"
import type { BillingProvider } from "./geo"

export type BillingAdmissionMode = "off" | "canary" | "public"
export type LocalBillingAdmissionMode = "off" | "public"
export type BillingAdmissionReason =
  "provider_off" | "invalid_allowlist" | "not_canary" | "canary" | "public" | "restricted_staging"

export interface BillingAdmissionDecision {
  allowed: boolean
  mode: BillingAdmissionMode
  reason: BillingAdmissionReason
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/
function parseCanaryWorkspaceIds(raw: string): Set<string> | null {
  if (!raw.trim()) return new Set()
  const ids = raw.split(",").map((id) => id.trim())
  if (ids.some((id) => !WORKSPACE_ID_PATTERN.test(id))) return null
  return new Set(ids)
}

export function evaluateBillingAdmission(input: {
  mode: BillingAdmissionMode
  workspaceId: string
  canaryWorkspaceIds: string
}): BillingAdmissionDecision {
  if (input.mode === "off") return { allowed: false, mode: input.mode, reason: "provider_off" }
  if (input.mode === "public") return { allowed: true, mode: input.mode, reason: "public" }
  const allowlist = parseCanaryWorkspaceIds(input.canaryWorkspaceIds)
  if (!allowlist) return { allowed: false, mode: input.mode, reason: "invalid_allowlist" }
  const allowed = allowlist.has(input.workspaceId)
  return { allowed, mode: input.mode, reason: allowed ? "canary" : "not_canary" }
}

export function getBillingAdmission(
  provider: BillingProvider,
  workspaceId: string,
  restrictedStagingAccess = false
): BillingAdmissionDecision {
  const decision = evaluateBillingAdmission({
    mode: provider === "polar" ? env.POLAR_BILLING_ADMISSION : env.RAZORPAY_BILLING_ADMISSION,
    workspaceId,
    canaryWorkspaceIds: env.BILLING_CANARY_WORKSPACE_IDS,
  })
  if (!decision.allowed && decision.reason === "provider_off" && restrictedStagingAccess) {
    if (isRestrictedBillingStagingProvider(provider)) {
      return { allowed: true, mode: "off", reason: "restricted_staging" }
    }
  }
  return decision
}

export function getLocalBillingAdmission(
  provider: BillingProvider,
  restrictedStagingAccess = false
): BillingAdmissionDecision {
  const mode: LocalBillingAdmissionMode =
    provider === "polar" ? env.POLAR_LOCAL_BILLING_ADMISSION : env.RAZORPAY_LOCAL_BILLING_ADMISSION
  if (mode === "public") return { allowed: true, mode, reason: "public" }
  if (restrictedStagingAccess && isRestrictedBillingStagingProvider(provider)) {
    return { allowed: true, mode, reason: "restricted_staging" }
  }
  return { allowed: false, mode, reason: "provider_off" }
}

function isRestrictedBillingStagingProvider(provider: BillingProvider): boolean {
  if (env.BILLING_STAGING_ADMISSION !== "restricted") return false
  if (billingStagingConfigError(env)) return false
  if (provider === "polar" && env.POLAR_ENVIRONMENT !== "sandbox") return false
  if (provider === "razorpay" && !env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) return false

  return true
}
