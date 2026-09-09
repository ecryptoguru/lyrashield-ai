export const SCAN_GOAL_LABELS: Record<string, string> = {
  CHECK_PR: "Check PR",
  TEST_APP: "Code review",
  LAUNCH_REVIEW: "Release check",
  WEEKLY_MONITOR: "Weekly monitor",
  FULL_PENTEST: "Deep security review",
  COMPLIANCE_REVIEW: "Compliance review",
  // Legacy identifier from the pre-V2 goal enum; kept so historical rows and
  // old clients still render a human label instead of the raw token.
  SECURITY_REVIEW: "Security review",
}

export const SCAN_MODE_LABELS: Record<string, string> = {
  SAFE: "Safe",
  QUICK: "Quick",
  STANDARD: "Standard",
  DEEP: "Deep",
  CUSTOM: "Custom",
}

export const SCAN_TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  retest: "Retest",
  schedule: "Schedule",
  webhook: "Webhook",
}

export const FINDING_SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
}

export const FINDING_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  FIX_READY: "Fix ready",
  PR_OPENED: "PR opened",
  TICKET_CREATED: "Ticket created",
  FIXED_PENDING_RETEST: "Fixed — pending retest",
  FIXED: "Fixed",
  ACCEPTED_RISK: "Risk accepted",
  FALSE_POSITIVE: "False positive",
  DUPLICATE: "Duplicate",
}

export const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  DETECTED: "Detected",
  VALIDATED: "Validated",
  VERIFIED: "Independently verified",
  INCONCLUSIVE: "Inconclusive",
}

export const TARGET_TYPE_LABELS: Record<string, string> = {
  REPO: "Repository",
  WEB_APP: "Web app",
  API: "API",
  IAC: "IaC",
}

export const SCAN_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  PREFLIGHT: "Checking setup",
  RUNNING: "Scanning",
  VERIFYING: "Verifying evidence",
  COMPLETED: "Completed",
  PARTIAL: "Partial",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  REQUIRES_APPROVAL: "Approval required",
  STOPPED_BUDGET: "Stopped by budget",
  TIMED_OUT: "Timed out",
}

// The user-facing surface is TargetEnvironment (LOCAL/PREVIEW/STAGING/
// PRODUCTION in the Prisma schema and @lyrashield/types). "EnvironmentKind"
// is kept as an alias key-set below so callers using either name resolve.
export const ENVIRONMENT_KIND_LABELS: Record<string, string> = {
  LOCAL: "Local",
  PREVIEW: "Preview",
  STAGING: "Staging",
  PRODUCTION: "Production",
}

export const WORKSPACE_PLAN_LABELS: Record<string, string> = {
  FREE: "Free",
  TRIAL: "Trial",
  STARTER: "Starter",
  PRO: "Pro",
  TEAM: "Team",
  AGENCY: "Agency",
  BUSINESS: "Business",
  LAUNCH_ASSURANCE: "Launch Assurance",
  ENTERPRISE: "Enterprise",
}

export function getScanGoalLabel(value: string): string {
  return SCAN_GOAL_LABELS[value] ?? value
}

export function getScanModeLabel(value: string): string {
  return SCAN_MODE_LABELS[value] ?? value
}

export function getScanTriggerLabel(value: string): string {
  return SCAN_TRIGGER_LABELS[value] ?? value
}

export function getFindingSeverityLabel(value: string): string {
  return FINDING_SEVERITY_LABELS[value] ?? value
}

export function getFindingStatusLabel(value: string): string {
  return FINDING_STATUS_LABELS[value] ?? value.replace(/_/g, " ")
}

export function getVerificationStatusLabel(value: string): string {
  return VERIFICATION_STATUS_LABELS[value] ?? value.replaceAll("_", " ")
}

export function getTargetTypeLabel(value: string): string {
  return TARGET_TYPE_LABELS[value] ?? value
}

export function getScanStatusLabel(value: string): string {
  return SCAN_STATUS_LABELS[value] ?? value.replaceAll("_", " ")
}

export function getEnvironmentKindLabel(value: string): string {
  return ENVIRONMENT_KIND_LABELS[value] ?? value.replaceAll("_", " ")
}

export function getWorkspacePlanLabel(value: string): string {
  return WORKSPACE_PLAN_LABELS[value] ?? value.replaceAll("_", " ")
}

/**
 * One lookup for every user-facing enum (v16 3.2): resolves `value` against
 * all label families and returns the first match, so callers that hold a
 * value without knowing its enum can still render human words. Returns
 * undefined when no family knows the value — callers decide their own
 * fallback (raw token, dash, "Unknown").
 */
export function describeEnum(value: string): string | undefined {
  for (const labels of [
    SCAN_GOAL_LABELS,
    SCAN_MODE_LABELS,
    SCAN_TRIGGER_LABELS,
    FINDING_SEVERITY_LABELS,
    FINDING_STATUS_LABELS,
    VERIFICATION_STATUS_LABELS,
    TARGET_TYPE_LABELS,
    SCAN_STATUS_LABELS,
    ENVIRONMENT_KIND_LABELS,
    WORKSPACE_PLAN_LABELS,
  ]) {
    const label = labels[value]
    if (label !== undefined) return label
  }
  return undefined
}
