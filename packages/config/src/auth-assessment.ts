/**
 * Authenticated-assessment staging beta admission gate.
 *
 * Two independent controls, BOTH required — the capability fails closed when
 * either is absent:
 *
 * 1. `LYRASHIELD_AUTH_ASSESSMENT_ENABLED` ("1"/"0", default "0") — the global
 *    kill switch. Deployable independently of every other flag.
 * 2. `LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST` — an explicit comma-separated
 *    canary allowlist. Each entry is either `workspaceId` (admits every
 *    target in that workspace) or `workspaceId:targetId` (admits one target).
 *    An empty or malformed allowlist admits nothing.
 *
 * Both the scan-create route and the worker execution-time admission re-check
 * evaluate this gate, so revoking access between queueing and execution still
 * denies the run.
 */

const ID_TOKEN = /^[A-Za-z0-9_-]{1,191}$/

export interface AuthAssessmentAllowlistEntry {
  workspaceId: string
  /** When set, only this target inside the workspace is admitted. */
  targetId?: string
}

/**
 * Parse the raw allowlist value. Returns null when ANY entry is malformed —
 * a partially parsed allowlist could silently widen or narrow the intended
 * scope, so a bad value fails closed rather than degrading to "empty".
 * Entries are `workspaceId` or `workspaceId:targetId`.
 */
export function parseAuthAssessmentAllowlist(raw: string): AuthAssessmentAllowlistEntry[] | null {
  if (!raw.trim()) return []
  const entries: AuthAssessmentAllowlistEntry[] = []
  for (const token of raw.split(",")) {
    const entry = token.trim()
    const parts = entry.split(":")
    if (parts.length > 2 || parts.some((part) => !ID_TOKEN.test(part))) {
      return null
    }
    const [workspaceId, targetId] = parts
    entries.push({ workspaceId: workspaceId!, ...(targetId ? { targetId } : {}) })
  }
  return entries
}

export type AuthAssessmentAdmissionReason =
  "flag_off" | "invalid_allowlist" | "not_allowlisted" | "allowlisted"

export interface AuthAssessmentAdmissionDecision {
  allowed: boolean
  reason: AuthAssessmentAdmissionReason
}

export function evaluateAuthAssessmentAdmission(input: {
  enabled: boolean
  /** Raw LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST value. */
  allowlist: string
  workspaceId: string
  targetId: string
}): AuthAssessmentAdmissionDecision {
  if (!input.enabled) return { allowed: false, reason: "flag_off" }
  const entries = parseAuthAssessmentAllowlist(input.allowlist)
  if (!entries) return { allowed: false, reason: "invalid_allowlist" }
  const allowed = entries.some(
    (entry) =>
      entry.workspaceId === input.workspaceId &&
      (entry.targetId === undefined || entry.targetId === input.targetId)
  )
  return { allowed, reason: allowed ? "allowlisted" : "not_allowlisted" }
}
