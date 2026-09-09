/**
 * W1-07: present failures as cause, effect, and recovery action.
 *
 * Every entry maps a structured server reason code — never parsed strings, raw
 * provider bodies, or internal errors — to an accurate next action. No failure
 * path creates an automatic approval or a paid replay.
 */

export interface OperationFailurePresentation {
  /** What went wrong, in user terms. */
  cause: string
  /** What the user can and cannot do until it is resolved. */
  effect: string
  /** The concrete next action. */
  recovery: string
  recoveryHref?: string
}

const ENTITLEMENT_CODES: Record<string, OperationFailurePresentation> = {
  TRIAL_EXPIRED: {
    cause: "Your workspace trial has ended.",
    effect: "New scans and retests are paused until a plan is active.",
    recovery: "Choose a plan to continue scanning.",
    recoveryHref: "/dashboard/billing",
  },
  NO_MINUTES_REMAINING: {
    cause: "This workspace has no included minutes remaining.",
    effect: "Model-backed scans and retests cannot start until usage is available.",
    recovery: "Review usage or add minutes, then retry.",
    recoveryHref: "/dashboard/billing",
  },
  TARGET_LIMIT_REACHED: {
    cause: "This workspace is at its target limit for the current plan.",
    effect: "Another target cannot be added until one is removed or the plan changes.",
    recovery: "Review your plan or remove an unused target.",
    recoveryHref: "/dashboard/billing",
  },
  DEEP_NOT_ALLOWED: {
    cause: "The current plan does not include deep reviews.",
    effect: "Deeper profiles stay unavailable; nothing was charged.",
    recovery: "Choose an included review, or upgrade if you need deeper coverage.",
    recoveryHref: "/dashboard/scans?new=1",
  },
  WORKSPACE_NOT_FOUND: {
    cause: "This workspace is no longer available.",
    effect: "Its scans and settings are not accessible from this session.",
    recovery: "Switch to an available workspace or contact an administrator.",
    recoveryHref: "/dashboard",
  },
}

const SCAN_CODES: Record<string, OperationFailurePresentation> = {
  SSRF_BLOCKED: {
    cause: "That address points to an internal, private, or unresolvable host.",
    effect: "LyraShield blocks targets that are not reachable public endpoints.",
    recovery: "Use a public repository, URL, or API you own or are authorized to scan.",
    recoveryHref: "/dashboard/targets",
  },
  TARGET_NOT_FOUND: {
    cause: "That target no longer exists in this workspace.",
    effect: "No scan can run against it.",
    recovery: "Pick another target or re-create it from Targets.",
    recoveryHref: "/dashboard/targets",
  },
  TARGET_TYPE_UNSUPPORTED: {
    cause: "This target type is not supported by the selected review.",
    effect: "Nothing was started and nothing was charged.",
    recovery: "Choose a review that supports this target type.",
    recoveryHref: "/dashboard/scans?new=1",
  },
  POLICY_NOT_FOUND: {
    cause: "The scan policy attached to this request no longer exists.",
    effect: "The scan cannot start with a missing policy.",
    recovery: "Start the scan again; a current policy will be applied.",
    recoveryHref: "/dashboard/scans?new=1",
  },
}

const CONNECTION_STATES: Record<string, OperationFailurePresentation> = {
  EXPIRED: {
    cause: "This connection's authorization has expired.",
    effect: "Automated actions for this connection are refused until it is renewed.",
    recovery: "Reconnect to restore the authorized workflows.",
    recoveryHref: "/dashboard/connections",
  },
  REVOKED: {
    cause: "This connection was revoked.",
    effect: "Automated actions no longer run for it.",
    recovery: "Reconnect if you still want this integration authorized.",
    recoveryHref: "/dashboard/connections",
  },
  PAUSED: {
    cause: "This connection is paused.",
    effect: "Its authorized workflows will not run until it is resumed.",
    recovery: "Resume the connection from its settings.",
    recoveryHref: "/dashboard/connections",
  },
}

/**
 * Map a structured reason code to its presentation. Unknown codes fall back to
 * a safe generic that never echoes raw error text, secrets, or internals.
 */
export function presentOperationFailure(
  code: string,
  context: { targetName?: string | null } = {}
): OperationFailurePresentation {
  const target = context.targetName ? ` for ${context.targetName}` : ""

  const entitlement = ENTITLEMENT_CODES[code]
  if (entitlement) return entitlement

  const scan = SCAN_CODES[code]
  if (scan) return scan

  const connectionState = CONNECTION_STATES[code]
  if (connectionState) return connectionState

  switch (code) {
    case "CONNECTION_EXPIRED":
    case "OAUTH_CONNECTION_REVOKED":
      return {
        cause: "The connection's authorization has expired or was revoked.",
        effect: "Automated actions for this connection are refused until it is reconnected.",
        recovery: "Reconnect the integration; a legacy limited grant is never silently expanded.",
        recoveryHref: "/dashboard/connections",
      }
    case "NO_REPOSITORIES":
      return {
        cause: "The GitHub installation has no accessible repositories.",
        effect:
          "Repository targets cannot be created until the installation can access at least one repository.",
        recovery: "Check the installation's repository access on GitHub, then retry.",
        recoveryHref: "/dashboard/connections",
      }
    case "TARGET_AUTHORIZATION_FAILED":
    case "VERIFICATION_REQUIRED":
      return {
        cause: `Source ownership could not be confirmed${target}.`,
        effect: "The target stays unauthorized; scans are not started and nothing is charged.",
        recovery:
          "Approve the provider's authorization prompt from the Connect button — that approval is what proves ownership.",
        recoveryHref: "/dashboard/connections",
      }
    case "INSTALLATION_ALREADY_CLAIMED":
      return {
        cause: "This installation is already connected to a different workspace.",
        effect: "An installation can only be linked to one workspace at a time.",
        recovery:
          "Disconnect it there first, or install the app on a different account or organisation.",
        recoveryHref: "/dashboard/connections",
      }
    case "SSRF_BLOCKED":
      return {
        cause: "That URL points to an internal, private, or unresolvable address.",
        effect: "The target was not created; the request was blocked before any fetch.",
        recovery: "Use a public target you own or are authorized to scan.",
        recoveryHref: "/dashboard/targets",
      }
    case "QUEUE":
    case "WORKER_UNAVAILABLE":
      return {
        cause: "Worker capacity was unavailable.",
        effect: "The scan could not start; no billable work occurred.",
        recovery: "Retry in a few minutes — capacity is reconciled automatically.",
        recoveryHref: "/dashboard/scans",
      }
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return {
        cause: "The service is temporarily unavailable.",
        effect:
          "The action did not complete; no approval was granted and no billable work started.",
        recovery: "Try again shortly. If it persists, check the status page before retrying.",
      }
    case "COVERAGE_INCOMPLETE":
      return {
        cause: "The last scan completed without evaluating the target.",
        effect:
          "There is no evidence to judge — this is not a clean result and no launch decision is possible.",
        recovery: "Review the scan's coverage details, then re-run the review.",
        recoveryHref: "/dashboard/scans",
      }
    default:
      return {
        cause: "The action could not be completed.",
        effect: "No automatic approval was created and no billable work was started.",
        recovery: "Review the details and retry, or contact support if it persists.",
      }
  }
}
