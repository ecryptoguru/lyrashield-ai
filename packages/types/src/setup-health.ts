import { z } from "zod"

export const SETUP_HEALTH_VERSION = "lyrashield-setup-health/1.0.0" as const
export const SETUP_HEALTH_TTL_MS = 60_000

export const SetupHealthStatusSchema = z.enum(["ready", "blocked", "unknown"])
export type SetupHealthStatus = z.infer<typeof SetupHealthStatusSchema>

export const SetupRecoveryActionSchema = z.enum([
  "SELECT_WORKSPACE",
  "RECONNECT_AGENT",
  "CONNECT_GITHUB",
  "VERIFY_DOMAIN",
  "ADD_API_SPEC",
  "REFRESH_ATTACHMENTS",
  "WAIT_FOR_PROVIDER",
  "WAIT_FOR_WORKER",
  "START_TRIAL",
  "REVIEW_BILLING",
  "EDIT_POLICY",
  "CONTACT_ADMIN",
  "RETRY_LATER",
])
export type SetupRecoveryAction = z.infer<typeof SetupRecoveryActionSchema>

export const SetupHealthScopeSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  goal: z.string().min(1),
  mode: z.string().min(1),
  workflow: z.string().min(1),
  policyFingerprint: z.string().nullable(),
  attachmentFingerprint: z.string().nullable(),
  authorizationFingerprint: z.string().nullable(),
  sourceRevision: z.string().nullable(),
})
export type SetupHealthScope = z.infer<typeof SetupHealthScopeSchema>

export const SetupHealthCheckSchema = z.object({
  code: z.string().min(1).max(96),
  status: SetupHealthStatusSchema,
  explanation: z.string().min(1).max(500),
  recoveryAction: SetupRecoveryActionSchema.nullable(),
})
export type SetupHealthCheck = z.infer<typeof SetupHealthCheckSchema>

export const SetupHealthSnapshotSchema = z.object({
  version: z.literal(SETUP_HEALTH_VERSION),
  status: SetupHealthStatusSchema,
  allowed: z.boolean(),
  checkedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  scope: SetupHealthScopeSchema,
  checks: z.array(SetupHealthCheckSchema),
  primaryCheck: z.string().min(1).max(96),
  limitations: z.array(z.string().max(500)),
})
export type SetupHealthSnapshot = z.infer<typeof SetupHealthSnapshotSchema>

/** Lower-case alias for callers that import runtime schemas by camelCase. */
export const setupHealthSnapshotSchema = SetupHealthSnapshotSchema

export interface SetupHealthSnapshotInput {
  allowed: boolean
  code?: string | null
  message?: string | null
  limitations?: string[]
  scope: SetupHealthScope
  scopeFingerprint: string
  dependencyUnavailable?: boolean
  now?: Date
}

const DOMAIN_CODES = new Set(["DOMAIN_VERIFICATION_REQUIRED"])
const ATTACHMENT_CODES = new Set([
  "SCAN_ATTACHMENT_NOT_FOUND",
  "SCAN_ATTACHMENT_REJECTED",
  "SCAN_ATTACHMENT_CAP_EXCEEDED",
])
const WORKER_CODES = new Set([
  "TARGET_RELAY_UNAVAILABLE",
  "SCAN_SERVICE_UNAVAILABLE",
  "WORKER_READINESS_UNAVAILABLE",
])
const BILLING_CODES = new Set([
  "NO_MINUTES_REMAINING",
  "AGENT_MINUTES_EXHAUSTED",
  "AGENT_MINUTES_OVERAGE_LIMIT",
  "OVERAGE_LIMIT_REACHED",
])
const POLICY_CODES = new Set(["POLICY_NOT_FOUND", "SCAN_PLAN_INVALID", "SCAN_PLAN_DENIED"])
const ADMIN_CODES = new Set([
  "SCAN_WORKFLOW_UNAVAILABLE",
  "AUTH_ASSESSMENT_AUTH_NOT_FOUND",
  "AUTH_ASSESSMENT_AUTH_EXPIRED",
  "AUTH_ASSESSMENT_AUTH_SCOPE_MISMATCH",
])
const AGENT_CODES = new Set([
  "AUTHENTICATION_REQUIRED",
  "FORBIDDEN",
  "OAUTH_SCOPE_DENIED",
  "CONNECTION_PAUSED",
  "CONNECTION_REVOKED",
  "CONNECTION_EXPIRED",
])

/** Stable client action for a server-owned reason code. */
export function setupRecoveryActionForCode(code: string | null | undefined): SetupRecoveryAction {
  if (!code) return "RETRY_LATER"
  if (code === "TARGET_NOT_FOUND" || code === "WORKSPACE_NOT_FOUND") return "SELECT_WORKSPACE"
  if (code === "TRIAL_AVAILABLE") return "START_TRIAL"
  if (code === "API_SPEC_REQUIRED") return "ADD_API_SPEC"
  if (code === "SCAN_SOURCE_UNAVAILABLE" || code === "CONNECTION_STATE_UNAVAILABLE") {
    return "CONNECT_GITHUB"
  }
  if (DOMAIN_CODES.has(code)) return "VERIFY_DOMAIN"
  if (ATTACHMENT_CODES.has(code) || code.startsWith("SCAN_ATTACHMENT_")) {
    return "REFRESH_ATTACHMENTS"
  }
  if (WORKER_CODES.has(code) || code.includes("WORKER")) return "WAIT_FOR_WORKER"
  if (code.includes("PROVIDER")) return "WAIT_FOR_PROVIDER"
  if (BILLING_CODES.has(code) || code.includes("MINUTES")) return "REVIEW_BILLING"
  if (POLICY_CODES.has(code)) return "EDIT_POLICY"
  if (ADMIN_CODES.has(code)) return "CONTACT_ADMIN"
  if (AGENT_CODES.has(code) || code.includes("AUTH") || code.includes("OAUTH")) {
    return "RECONNECT_AGENT"
  }
  if (
    code === "FREE_URL_SCAN_RATE_LIMITED" ||
    code === "ELIGIBILITY_RATE_LIMITED" ||
    code === "SCAN_RATE_LIMITED"
  ) {
    return "RETRY_LATER"
  }
  return "RETRY_LATER"
}

function safeExplanation(value: string | null | undefined, fallback: string): string {
  const text = value?.trim() || fallback
  return text.slice(0, 500)
}

/**
 * Build the cross-client setup-health projection from the legacy eligibility
 * result. The legacy route remains the authority for admission checks; this
 * function only gives those same reason codes a versioned, client-neutral
 * shape. It performs no I/O and creates no permission of its own.
 */
export function buildSetupHealthSnapshot(input: SetupHealthSnapshotInput): SetupHealthSnapshot {
  const now = input.now ?? new Date()
  const checkedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + SETUP_HEALTH_TTL_MS).toISOString()

  if (input.allowed) {
    return {
      version: SETUP_HEALTH_VERSION,
      status: "ready",
      allowed: true,
      checkedAt,
      expiresAt,
      scopeFingerprint: input.scopeFingerprint,
      scope: input.scope,
      checks: [
        {
          code: "SETUP_READY",
          status: "ready",
          explanation:
            "The required setup checks passed. Scan creation rechecks them before admission.",
          recoveryAction: null,
        },
      ],
      primaryCheck: "SETUP_READY",
      limitations: (input.limitations ?? []).map((item) => item.slice(0, 500)),
    }
  }

  const code = input.code?.slice(0, 96) || "SETUP_BLOCKED"
  const status: SetupHealthStatus = input.dependencyUnavailable ? "unknown" : "blocked"
  return {
    version: SETUP_HEALTH_VERSION,
    status,
    allowed: false,
    checkedAt,
    expiresAt,
    scopeFingerprint: input.scopeFingerprint,
    scope: input.scope,
    checks: [
      {
        code,
        status,
        explanation: safeExplanation(input.message, "This review cannot be started yet."),
        recoveryAction: setupRecoveryActionForCode(code),
      },
    ],
    primaryCheck: code,
    limitations: (input.limitations ?? []).map((item) => item.slice(0, 500)),
  }
}
