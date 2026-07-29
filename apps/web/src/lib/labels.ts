import type { ScanMode, FindingSeverity, FindingStatus } from "@lyrashield/types"

export const GOAL_OPTIONS = [
  {
    value: "CHECK_PR",
    label: "Check a PR",
    description: "Review a pull request before merging.",
  },
  {
    value: "TEST_APP",
    label: "Code review",
    description: "Broader repository and dependency analysis.",
  },
  {
    value: "LAUNCH_REVIEW",
    label: "Release check",
    description: "Check what needs attention before release.",
  },
  {
    value: "WEEKLY_MONITOR",
    label: "Weekly monitor",
    description: "Set a recurring review goal.",
  },
  {
    value: "FULL_PENTEST",
    label: "Deep security review",
    description: "A thorough security review with evidence.",
  },
  {
    value: "COMPLIANCE_REVIEW",
    label: "Compliance review",
    description: "Map findings to compliance objectives.",
  },
] as const

export type GoalValue = (typeof GOAL_OPTIONS)[number]["value"]

export function getGoalLabel(value: string): string {
  return GOAL_OPTIONS.find((g) => g.value === value)?.label ?? value
}

export function getGoalDescription(value: string): string {
  return GOAL_OPTIONS.find((g) => g.value === value)?.description ?? ""
}

/**
 * The single place remaining raw database values become words a user reads.
 *
 * The enum maps below are exhaustive `Record<Enum, string>`, so adding a value to the schema
 * without a label is a typecheck failure rather than a screen showing FIXED_PENDING_RETEST
 * to a solo developer. Per-screen label maps with differing coverage are how raw values
 * leaked in the first place.
 */
export const MODE_LABELS: Record<ScanMode, string> = {
  SAFE: "Safe",
  QUICK: "Quick",
  STANDARD: "Standard",
  DEEP: "Deep",
  CUSTOM: "Custom",
}

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  INFO: "Info",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
}

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  OPEN: "Open",
  FIX_READY: "Fix ready",
  PR_OPENED: "PR opened",
  TICKET_CREATED: "Ticket created",
  FIXED_PENDING_RETEST: "Awaiting retest",
  FIXED: "Fixed",
  ACCEPTED_RISK: "Risk accepted",
  FALSE_POSITIVE: "Not a real issue",
  DUPLICATE: "Duplicate",
}

/**
 * Turns an unknown SCREAMING_SNAKE token into something readable.
 *
 * Used for columns the schema stores as free-form strings rather than enums
 * (`Evidence.type`, `Scan.triggerType`), where an exhaustive map is impossible and a
 * hardcoded list would silently fall back to the raw value as new kinds appear.
 */
export function humanizeToken(value: string | null | undefined): string {
  if (!value) return "Unknown"
  const spaced = value.replace(/[_-]+/g, " ").trim().toLowerCase()
  if (!spaced) return "Unknown"
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  SCREENSHOT: "Screenshot",
  LOG_SNIPPET: "Log output",
  CODE_SNIPPET: "Code excerpt",
  HTTP_EXCHANGE: "HTTP exchange",
  POC: "Proof of concept",
}

export function evidenceTypeLabel(value: string | null | undefined): string {
  if (!value) return "Evidence"
  return EVIDENCE_TYPE_LABELS[value] ?? humanizeToken(value)
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Started manually",
  scheduled: "Scheduled",
  webhook: "Triggered by webhook",
  api: "Started via API",
  ci: "Started from CI",
}

export function triggerLabel(value: string | null | undefined): string {
  if (!value) return "Unknown trigger"
  return TRIGGER_LABELS[value.toLowerCase()] ?? humanizeToken(value)
}

/** Safe lookups for values arriving as plain strings across an API boundary. */
export function modeLabel(value: string | null | undefined): string {
  if (!value) return "Standard"
  return MODE_LABELS[value as ScanMode] ?? humanizeToken(value)
}

export function severityLabel(value: string | null | undefined): string {
  if (!value) return "Unknown"
  return SEVERITY_LABELS[value as FindingSeverity] ?? humanizeToken(value)
}

export function findingStatusLabel(value: string | null | undefined): string {
  if (!value) return "Unknown"
  return FINDING_STATUS_LABELS[value as FindingStatus] ?? humanizeToken(value)
}
