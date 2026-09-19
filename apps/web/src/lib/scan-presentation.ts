import { isAgentMinutesExhaustedError } from "@lyrashield/types"

type ScanStatus =
  | "QUEUED"
  | "PREFLIGHT"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REQUIRES_APPROVAL"
  | "STOPPED_BUDGET"
  | "TIMED_OUT"
  | string

type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

interface ScanPresentation {
  label: string
  headline: string
  description: string
  badgeVariant: BadgeVariant
  assuranceAvailable: boolean
  showFailureDetails: boolean
  recoveryAction?: "usage"
}

interface ScanPresentationContext {
  errorCategory?: string | null
  errorMessage?: string | null
}

const ACTIVE_STATUSES = new Set<ScanStatus>([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
])

export function isActiveScan(status: ScanStatus) {
  return ACTIVE_STATUSES.has(status)
}

/**
 * URL-backed run-state filters. Each state maps to the scan statuses it
 * covers; "ALL" maps to no filter. Shared by GET /api/scans (validated) and
 * the Runs page so the URL, API, and UI can never disagree.
 */
export const SCAN_STATE_FILTERS = [
  "ALL",
  "ACTIVE",
  "COMPLETED",
  "NEEDS_ATTENTION",
  "CANCELLED",
] as const

export type ScanStateFilter = (typeof SCAN_STATE_FILTERS)[number]

const SCAN_STATE_STATUSES: Record<Exclude<ScanStateFilter, "ALL">, string[]> = {
  ACTIVE: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"],
  COMPLETED: ["COMPLETED", "PARTIAL"],
  NEEDS_ATTENTION: ["FAILED", "STOPPED_BUDGET", "TIMED_OUT"],
  CANCELLED: ["CANCELLED"],
}

export function parseScanStateFilter(value: string | undefined | null): ScanStateFilter {
  return (SCAN_STATE_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as ScanStateFilter)
    : "ALL"
}

/** Status list for a state filter, or null when the state is ALL. */
export function scanStateStatuses(state: ScanStateFilter): string[] | null {
  return state === "ALL" ? null : SCAN_STATE_STATUSES[state]
}

/** User-facing label for a state filter option. */
export function scanStateStatusLabel(state: ScanStateFilter): string {
  switch (state) {
    case "ALL":
      return "All states"
    case "ACTIVE":
      return "Active"
    case "COMPLETED":
      return "Completed"
    case "NEEDS_ATTENTION":
      return "Needs attention"
    case "CANCELLED":
      return "Cancelled"
  }
}

export function getScanPresentation(
  status: ScanStatus,
  context: ScanPresentationContext = {}
): ScanPresentation {
  switch (status) {
    case "COMPLETED":
      return {
        label: "Completed",
        headline: "Scan completed",
        description:
          "Results are available below. Review coverage before treating a clean result as complete.",
        badgeVariant: "success",
        assuranceAvailable: true,
        showFailureDetails: false,
      }
    case "PARTIAL":
      return {
        label: "Partial",
        headline: "Scan completed with gaps",
        description:
          "The scan did not cover its full scope. Partial findings are available below, but coverage may be incomplete — do not treat this as a complete result.",
        badgeVariant: "warning",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "FAILED": {
      // Named failure causes get their own truthful label — a missing source,
      // revoked authorization, or unsupported input is a different outcome than
      // a generic crash, and none of them produce assurance.
      const failure = failedScanPresentation(context.errorCategory ?? null)
      if (failure) return failure
      return {
        label: "Failed",
        headline: "Scan failed",
        description:
          "No assurance result was produced. Review the failure details before trying again.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    }
    case "STOPPED_BUDGET":
      if (isAgentMinutesExhaustedError(context.errorCategory, context.errorMessage)) {
        return {
          label: "Minutes exhausted",
          headline: "Scan stopped because workspace minutes ran out",
          description:
            "No complete assurance result was produced. Review workspace usage before starting another model-backed scan.",
          badgeVariant: "warning",
          assuranceAvailable: false,
          showFailureDetails: true,
          recoveryAction: "usage",
        }
      }
      return {
        label: "Stopped by budget",
        headline: "Scan stopped at its budget limit",
        description:
          "No complete assurance result was produced. Review the available details before increasing a budget or retrying.",
        badgeVariant: "warning",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "TIMED_OUT":
      return {
        label: "Timed out",
        headline: "Scan timed out",
        description:
          "No complete assurance result was produced. Check the target and try again when it is reachable.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "CANCELLED":
      return {
        label: "Cancelled",
        headline: "Scan was cancelled",
        description: "No complete assurance result was produced.",
        badgeVariant: "muted",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
    case "REQUIRES_APPROVAL":
      return {
        label: "Approval required",
        headline: "Scan needs approval",
        description: "Review the requested scope before scan work can continue.",
        badgeVariant: "warning",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
    case "PREFLIGHT":
      return {
        label: "Checking setup",
        headline: "Checking the scan setup",
        description: "LyraShield is validating the target and scan requirements.",
        badgeVariant: "info",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
    case "RUNNING":
    case "VERIFYING":
      return {
        label: status === "VERIFYING" ? "Verifying evidence" : "Scanning",
        headline: status === "VERIFYING" ? "Verifying evidence" : "Scan in progress",
        description: "Results will appear here as the scan reaches a reliable state.",
        badgeVariant: "default",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
    case "QUEUED":
      return {
        label: "Queued",
        headline: "Scan queued",
        description: "The scan will start when worker capacity is available.",
        badgeVariant: "muted",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
    default:
      return {
        label: status.replaceAll("_", " "),
        headline: "Scan status unavailable",
        description:
          "This scan has an unrecognized state. Review technical details before relying on it.",
        badgeVariant: "muted",
        assuranceAvailable: false,
        showFailureDetails: false,
      }
  }
}

/**
 * Explicit FAILED-state causes. Each maps an errorCategory recorded by the
 * worker to a truthful headline — the scan detail must distinguish missing
 * source, revoked authorization, unsupported checks, rejected input, and
 * evidence export failure instead of flattening everything into "failed".
 * Every entry keeps `assuranceAvailable: false`: an incomplete scan never
 * reads as a clean score.
 */
function failedScanPresentation(errorCategory: string | null): ScanPresentation | null {
  switch (errorCategory) {
    case "NO_ANALYZABLE_CHANGES":
      return {
        label: "No analyzable changes",
        headline: "No analyzable changes in this diff",
        description:
          "The recorded revisions produced no files the engine could analyze. No assurance result was produced.",
        badgeVariant: "muted",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "SCAN_SOURCE_UNAVAILABLE":
    case "SCAN_NO_MERGE_BASE":
    case "SCAN_REF_UNRESOLVED":
    case "SCAN_CLONE_FAILED":
      return {
        label: "Source unavailable",
        headline: "Source could not be fetched",
        description:
          "The recorded source was missing or could not be checked out. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "RELAY_SCOPE_UNAVAILABLE":
    case "AUTHORIZATION_REVOKED":
    case "CONNECTION_REVOKED":
    case "RELAY_GRANT_DENIED":
      return {
        label: "Authorization unavailable",
        headline: "Scan authorization was revoked or unavailable",
        description:
          "The delegated scope for this scan was revoked or could not be issued. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "EVIDENCE_STORAGE_CONFIGURATION":
    case "EVIDENCE_EXPORT_FAILED":
      return {
        label: "Evidence export failed",
        headline: "Evidence could not be exported",
        description:
          "The scan's evidence artifacts could not be stored or exported. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "SCAN_ATTACHMENT_UNAVAILABLE":
    case "SCAN_ATTACHMENT_CHECKSUM_MISMATCH":
    case "SCAN_ATTACHMENT_STAGING":
      return {
        label: "Supporting file unavailable",
        headline: "A supporting file could not be verified",
        description:
          "An attachment recorded on the scan's plan was missing, deleted, or failed checksum verification. The scan did not run against different inputs. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "PROMPT_INJECTION":
    case "INSTRUCTION_UNSAFE":
      return {
        label: "Unsupported input",
        headline: "Scan input was rejected",
        description:
          "The scan's instruction text failed the input safety check. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "UNSUPPORTED_CHECKS":
    case "SCANNER_UNSUPPORTED":
      return {
        label: "Unsupported checks",
        headline: "Requested checks are not supported",
        description:
          "One or more checks this scan requested are not supported for the target. No assurance result was produced.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    default:
      return null
  }
}
