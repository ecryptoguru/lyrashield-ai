/**
 * Outbound connector admission gate — the canary rollout control for
 * delegated connector invocations. Same off/canary/public posture as billing
 * admission: `off` denies every invocation, `canary` admits only an explicit
 * workspace allowlist, and a malformed allowlist fails closed rather than
 * opening the capability.
 *
 * Pure function — callers read env and pass the mode + allowlist in.
 */

export type ConnectorAdmissionMode = "off" | "canary" | "public"
export type ConnectorAdmissionReason =
  "connectors_off" | "invalid_allowlist" | "not_canary" | "canary" | "public"

export interface ConnectorAdmissionDecision {
  allowed: boolean
  mode: ConnectorAdmissionMode
  reason: ConnectorAdmissionReason
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/

export function parseConnectorCanaryWorkspaceIds(raw: string): Set<string> | null {
  if (!raw.trim()) return new Set()
  const ids = raw.split(",").map((id) => id.trim())
  if (ids.some((id) => !WORKSPACE_ID_PATTERN.test(id))) return null
  return new Set(ids)
}

export function evaluateConnectorAdmission(input: {
  mode: ConnectorAdmissionMode
  workspaceId: string
  canaryWorkspaceIds: string
}): ConnectorAdmissionDecision {
  if (input.mode === "off") return { allowed: false, mode: input.mode, reason: "connectors_off" }
  if (input.mode === "public") return { allowed: true, mode: input.mode, reason: "public" }
  const allowlist = parseConnectorCanaryWorkspaceIds(input.canaryWorkspaceIds)
  if (!allowlist) return { allowed: false, mode: input.mode, reason: "invalid_allowlist" }
  const allowed = allowlist.has(input.workspaceId)
  return { allowed, mode: input.mode, reason: allowed ? "canary" : "not_canary" }
}
