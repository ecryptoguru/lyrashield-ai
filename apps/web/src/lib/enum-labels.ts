export const SCAN_GOAL_LABELS: Record<string, string> = {
  CHECK_PR: "Check PR",
  TEST_APP: "Code review",
  LAUNCH_REVIEW: "Release check",
  WEEKLY_MONITOR: "Weekly monitor",
  FULL_PENTEST: "Deep security review",
  COMPLIANCE_REVIEW: "Compliance review",
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
