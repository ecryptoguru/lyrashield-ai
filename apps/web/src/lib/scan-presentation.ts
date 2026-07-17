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

export interface ScanPresentation {
  label: string
  headline: string
  description: string
  badgeVariant: BadgeVariant
  assuranceAvailable: boolean
  showFailureDetails: boolean
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

export function getScanPresentation(status: ScanStatus): ScanPresentation {
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
    case "FAILED":
      return {
        label: "Failed",
        headline: "Scan failed",
        description:
          "No assurance result was produced. Review the failure details before trying again.",
        badgeVariant: "danger",
        assuranceAvailable: false,
        showFailureDetails: true,
      }
    case "STOPPED_BUDGET":
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
