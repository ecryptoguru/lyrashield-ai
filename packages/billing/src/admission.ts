import { env } from "@lyrashield/config"
import type { BillingProvider } from "./geo"

export type BillingAdmissionMode = "off" | "canary" | "public"
export type BillingAdmissionReason =
  "provider_off" | "invalid_allowlist" | "not_canary" | "canary" | "public"

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
  if (input.mode === "off") {
    return { allowed: false, mode: input.mode, reason: "provider_off" }
  }
  if (input.mode === "public") {
    return { allowed: true, mode: input.mode, reason: "public" }
  }
  const allowlist = parseCanaryWorkspaceIds(input.canaryWorkspaceIds)
  if (!allowlist) {
    return { allowed: false, mode: input.mode, reason: "invalid_allowlist" }
  }
  const allowed = allowlist.has(input.workspaceId)
  return { allowed, mode: input.mode, reason: allowed ? "canary" : "not_canary" }
}

export function getBillingAdmission(
  provider: BillingProvider,
  workspaceId: string
): BillingAdmissionDecision {
  return evaluateBillingAdmission({
    mode: provider === "polar" ? env.POLAR_BILLING_ADMISSION : env.RAZORPAY_BILLING_ADMISSION,
    workspaceId,
    canaryWorkspaceIds: env.BILLING_CANARY_WORKSPACE_IDS,
  })
}
