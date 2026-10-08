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
  /**
   * What the recovery button should say when this presentation is rendered with
   * one. A reconciliation failure must not offer a bare "Try again": retrying
   * without reading the accepted work first can start a second paid action.
   */
  retryLabel?: string
  /**
   * True when the outcome of the submitted work is unknown. The caller must
   * reconcile the existing action identity before it offers any retry.
   */
  requiresReconciliation?: boolean
}

/**
 * The scan-admission codes the scan POST returns that previously had no entry,
 * so a first-time user saw the generic "did not complete" card instead of the
 * server's actionable sentence. Every one of these refuses the scan before any
 * paid work starts, except the two that report work already accepted.
 */
const SCAN_ADMISSION_CODES: Record<string, OperationFailurePresentation> = {
  SCAN_RATE_LIMITED: {
    cause: "Too many scans were started from this workspace in the last minute.",
    effect: "This scan was not started.",
    recovery: "Wait a moment, then start the scan again.",
    recoveryHref: "/dashboard/scans",
    retryLabel: "Try again",
  },
  SCAN_CONCURRENCY_LIMIT: {
    cause: "This workspace already has its maximum number of scans running.",
    effect: "This scan was not started.",
    recovery: "Wait for a running scan to finish, then start this one.",
    recoveryHref: "/dashboard/scans",
    retryLabel: "Try again",
  },
  SCAN_IN_PROGRESS: {
    cause: "This target already has an active scan.",
    effect: "The second scan was not started.",
    recovery: "Open the active scan, or cancel it before starting another.",
    recoveryHref: "/dashboard/scans",
  },
  SCAN_SERVICE_UNAVAILABLE: {
    cause: "The scan service is temporarily unavailable.",
    effect: "This scan was not started. No work was accepted for it.",
    recovery: "Wait a moment, then start the scan again.",
    recoveryHref: "/dashboard/scans",
    retryLabel: "Try again",
  },
  SCAN_SOURCE_UNAVAILABLE: {
    cause: "This review needs a source that is not connected.",
    effect: "This scan was not started.",
    recovery: "Reconnect the repository or choose a review that fits this target.",
    recoveryHref: "/dashboard/connections",
  },
  SCAN_AUTHORIZATION_REQUIRED: {
    cause: "This review needs a recorded, scoped authorization for the target.",
    effect: "This scan was not started.",
    recovery: "Record the authorization for this target, then start the scan again.",
    recoveryHref: "/dashboard/targets",
  },
  SCAN_PLAN_INVALID: {
    cause: "This review cannot run against the selected target.",
    effect: "This scan was not started.",
    recovery: "Choose a review that fits this target.",
    recoveryHref: "/dashboard/scans?new=1",
  },
  SCAN_PLAN_DENIED: {
    cause: "The current plan does not allow this review.",
    effect: "This scan was not started.",
    recovery: "Choose an included review or review your plan.",
    recoveryHref: "/dashboard/billing",
  },
  SCAN_WORKFLOW_UNAVAILABLE: {
    cause: "This review is not available for the selected target.",
    effect: "This scan was not started.",
    recovery: "Choose an available review and start again.",
    recoveryHref: "/dashboard/scans?new=1",
  },
  SCAN_NO_MERGE_BASE: {
    cause: "No merge base could be resolved between the two revisions.",
    effect: "This scan was not started.",
    recovery: "Fetch the branches on the provider, then start the review again.",
    recoveryHref: "/dashboard/targets",
  },
  SCAN_REF_UNRESOLVED: {
    cause: "A requested branch or revision could not be resolved.",
    effect: "This scan was not started.",
    recovery: "Check the branch name on the provider, then start the review again.",
    recoveryHref: "/dashboard/targets",
  },
  FREE_URL_SCAN_RATE_LIMITED: {
    cause: "Free-plan remote URL reviews are temporarily limited for your network.",
    effect: "This scan was not started.",
    recovery: "Wait for the limit to reset, or verify the domain to lift it.",
    recoveryHref: "/dashboard/billing",
  },
}

/**
 * A scan waiting on a human, or a request whose outcome the browser cannot
 * establish. Both keep the unknown-outcome wording and demand a status read
 * before any retry, so a retry can never start a second scan.
 */
const UNRESOLVED_OUTCOME_CODES: Record<string, OperationFailurePresentation> = {
  NETWORK_ERROR: {
    cause: "The connection dropped before this request reported an outcome.",
    effect:
      "This message does not establish the final outcome of any work already accepted. A scan may already be starting.",
    recovery:
      "Check the status of the previous attempt before starting another scan. Starting a second attempt can create a duplicate paid scan.",
    retryLabel: "Check the scan status",
    requiresReconciliation: true,
  },
  TIMEOUT: {
    cause: "The request did not answer in time.",
    effect:
      "This message does not establish the final outcome of any work already accepted. A scan may already be starting.",
    recovery:
      "Check the status of the previous attempt before starting another scan. Starting a second attempt can create a duplicate paid scan.",
    retryLabel: "Check the scan status",
    requiresReconciliation: true,
  },
}

const ENTITLEMENT_CODES: Record<string, OperationFailurePresentation> = {
  TRIAL_EXPIRED: {
    cause: "Your workspace trial has ended.",
    effect: "New scans and retests are paused until a plan is active.",
    recovery: "Choose a plan to continue scanning.",
    recoveryHref: "/dashboard/billing",
  },
  NO_MINUTES_REMAINING: {
    cause: "Your billing account has no included minutes remaining.",
    effect: "Model-backed scans and retests cannot start until account usage is available.",
    recovery: "Review account usage or add minutes, then retry.",
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
    effect: "Deeper profiles stay unavailable.",
    recovery: "Choose an included review or upgrade if you need deeper coverage.",
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
    cause: "That address points to an internal, private or unresolvable host.",
    effect: "LyraShield blocks targets that are not reachable public endpoints.",
    recovery: "Use a public repository, URL or API you own or are authorized to scan.",
    recoveryHref: "/dashboard/targets",
  },
  TARGET_NOT_FOUND: {
    cause: "That target no longer exists in this workspace.",
    effect: "No scan can run against it.",
    recovery: "Pick another target or re-create it from Targets.",
    recoveryHref: "/dashboard/targets",
  },
  TARGET_EXISTS: {
    cause: "A target for this source already exists in your workspace.",
    effect:
      "No duplicate target was created; review the existing target's settings before continuing.",
    recovery: "Open Targets to review the current target list.",
    recoveryHref: "/dashboard/targets",
  },
  TARGET_TYPE_UNSUPPORTED: {
    cause: "This target type is not supported by the selected review.",
    effect: "Nothing was started.",
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
 * Accept a server sentence for display only when it is plainly a sentence about
 * this operation. Anything that could be an internal error, a stack frame, a
 * provider body, a URL or a token is rejected and the caller keeps the generic
 * copy. Returning null is always the safe answer.
 */
const MAX_SERVER_MESSAGE_LENGTH = 300
const SERVER_MESSAGE_REJECTIONS: readonly RegExp[] = [
  // Internal error and stack shapes.
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ZodError|PrismaClient\w*Error)\b/,
  /\b(?:at\s+\S+\s*\(|node_modules|\.tsx?:\d+|\.js:\d+)/,
  /\b(?:stack|traceback|stacktrace|sqlstate|constraint|foreign key)\b/i,
  // Provider and infrastructure bodies.
  /<[a-z!/]/i,
  /\{\s*"|\}\s*$/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._-]{8,}/,
  // Hosts, addresses and paths that are not part of a sentence a user needs.
  /https?:\/\//i,
  // Dotted quad: the four octets are spelled out rather than wrapped in a
  // repeated group, so the pattern has no nested repetition. It still rejects
  // any four dot-separated runs of one to three digits.
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  // Raw tokens: long unbroken strings that are not words.
  /[A-Za-z0-9_-]{40,}/,
]

export function sanitizeServerMessage(message: unknown): string | null {
  if (typeof message !== "string") return null
  // A format character — a bidi override, an invisible separator, a
  // zero-width joiner — can reorder or hide the words a reader sees, so a
  // sentence that carries one is rejected outright instead of repaired.
  // Collapsing it would display a different sentence from the one the server
  // sent, which is exactly the substitution an override is used for.
  if (/\p{Cf}/u.test(message)) return null
  // Control characters carry no display meaning, so those are collapsed.
  const collapsed = message
    .replace(/[\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!collapsed) return null
  if (collapsed.length > MAX_SERVER_MESSAGE_LENGTH) return null
  // A sentence a user reads starts with a capital and ends with punctuation.
  if (!/^[A-Z]/.test(collapsed)) return null
  if (!/[.!?]$/.test(collapsed)) return null
  if (SERVER_MESSAGE_REJECTIONS.some((pattern) => pattern.test(collapsed))) return null
  return collapsed
}

/**
 * A DNS record name, or nothing. The remediation value crosses an API boundary
 * into rendered copy, so it is accepted only when it looks like the record name
 * the scan route builds (`_lyrashield.<domain>`) and fits the DNS length limit.
 *
 * Each label is validated on its own and the name is split on the dots, rather
 * than repeating a label group inside one pattern. The accepted set is
 * unchanged: an optional leading underscore on the first label, an optional
 * trailing dot, and labels of alphanumerics and hyphens that begin and end with
 * an alphanumeric. The 253-character cap is enforced separately below.
 */
const DNS_LABEL = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/
const MAX_DNS_NAME_LENGTH = 253

function isDnsRecordName(value: string): boolean {
  const body = value.endsWith(".") ? value.slice(0, -1) : value
  if (!body) return false
  return body.split(".").every((label, index) => {
    const candidate = index === 0 && label.startsWith("_") ? label.slice(1) : label
    return DNS_LABEL.test(candidate)
  })
}

function sanitizeDnsRecordName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_DNS_NAME_LENGTH) return null
  if (!isDnsRecordName(trimmed)) return null
  return trimmed
}

/**
 * The remediation the scan POST attaches to DOMAIN_VERIFICATION_REQUIRED:
 * `details.remediation.txtName` (the TXT record name) and `verifyPath`.
 * Onboarding previously discarded both, so the user was told to verify a
 * domain without being told which record to publish.
 */
function remediationFromDetails(context: { details?: unknown; targetId?: string | null }): {
  txtName: string | null
  verifyPath: string | null
} {
  const details = context.details
  if (typeof details !== "object" || details === null) return { txtName: null, verifyPath: null }
  const remediation = (details as { remediation?: unknown }).remediation
  if (typeof remediation !== "object" || remediation === null) {
    return { txtName: null, verifyPath: null }
  }
  const record = remediation as { txtName?: unknown; verifyPath?: unknown }
  const txtName = sanitizeDnsRecordName(record.txtName)
  // Only a workspace-relative dashboard path is ever rendered as a link.
  const verifyPath =
    typeof record.verifyPath === "string" &&
    /^\/dashboard\/[A-Za-z0-9/_-]*$/.test(record.verifyPath)
      ? record.verifyPath
      : null
  return { txtName, verifyPath }
}

function domainVerificationTxtName(context: { details?: unknown }): string | null {
  return remediationFromDetails(context).txtName
}

function domainVerificationHref(context: { details?: unknown; targetId?: string | null }): string {
  const { verifyPath } = remediationFromDetails(context)
  if (verifyPath) return `${verifyPath}#domain-verification`
  if (context.targetId) {
    return `/dashboard/targets/${encodeURIComponent(context.targetId)}#domain-verification`
  }
  return "/dashboard/targets"
}

/**
 * Map a structured reason code to its presentation. Unknown codes fall back to
 * a safe generic that never echoes raw error text, secrets, or internals.
 *
 * `context.serverMessage` is the server's own sentence for this code. It is
 * used ONLY for a code with no entry above, and only after `sanitizeServerMessage`
 * has accepted it — so an unmapped code shows the same actionable text the scan
 * sheet shows instead of a generic card, and a hostile or internal string never
 * reaches the screen.
 */
export function presentOperationFailure(
  code: string,
  context: {
    targetName?: string | null
    serverMessage?: string | null
    details?: unknown
    targetId?: string | null
  } = {}
): OperationFailurePresentation {
  const target = context.targetName ? ` for ${context.targetName}` : ""

  const entitlement = ENTITLEMENT_CODES[code]
  if (entitlement) return entitlement

  const scan = SCAN_CODES[code]
  if (scan) return scan

  const admission = SCAN_ADMISSION_CODES[code]
  if (admission) return admission

  const unresolved = UNRESOLVED_OUTCOME_CODES[code]
  if (unresolved) return unresolved

  const connectionState = CONNECTION_STATES[code]
  if (connectionState) return connectionState

  switch (code) {
    case "DOMAIN_VERIFICATION_REQUIRED": {
      const txtName = domainVerificationTxtName(context)
      return {
        cause: "This domain is not verified for engine-backed reviews.",
        effect: "This scan was not started.",
        recovery: txtName
          ? `Publish the DNS TXT record ${txtName}, then verify the domain.`
          : "Publish the domain's DNS TXT record, then verify the domain.",
        recoveryHref: domainVerificationHref(context),
        retryLabel: "Try again",
      }
    }
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
        effect: "The target stays unauthorized and scans are not started.",
        recovery:
          "Approve the provider's authorization prompt from the Connect button — that approval is what proves ownership.",
        recoveryHref: "/dashboard/connections",
      }
    case "INSTALLATION_ALREADY_CLAIMED":
      return {
        cause: "This installation is already connected to a different workspace.",
        effect: "An installation can only be linked to one workspace at a time.",
        recovery:
          "Disconnect it there first or install the app on a different account or organisation.",
        recoveryHref: "/dashboard/connections",
      }
    case "SSRF_BLOCKED":
      return {
        cause: "That URL points to an internal, private or unresolvable address.",
        effect: "The target was not created; the request was blocked before any fetch.",
        recovery: "Use a public target you own or are authorized to scan.",
        recoveryHref: "/dashboard/targets",
      }
    case "QUEUE":
    case "WORKER_UNAVAILABLE":
      return {
        cause: "Worker capacity was unavailable.",
        effect: "Check the scan's status before starting another action.",
        recovery: "Review the scan status and coverage before retrying.",
        recoveryHref: "/dashboard/scans",
      }
    case "STOPPED_BUDGET":
      return {
        cause: "This scan stopped after reaching its protected per-scan budget.",
        effect:
          "This cap applies to one scan and does not show how many minutes remain in your billing account.",
        recovery: "Review this scan's result and your account usage before starting another scan.",
        recoveryHref: "/dashboard/scans",
      }
    case "TIMED_OUT":
      return {
        cause: "The scan timed out before producing a complete result.",
        effect: "Check the scan's status and coverage before starting another action.",
        recovery: "Review the scan details and coverage before deciding whether to retry.",
        recoveryHref: "/dashboard/scans",
      }
    case "FAILED":
      return {
        cause: "The scan did not produce a complete result.",
        effect: "Check the scan's status and coverage before starting another action.",
        recovery: "Review the scan details and current coverage before deciding whether to retry.",
        recoveryHref: "/dashboard/scans",
      }
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return {
        cause: "The service is temporarily unavailable.",
        effect: "Check the action's status before starting another action.",
        recovery:
          "Review the latest status before retrying. If the issue persists, check the status page.",
      }
    case "COVERAGE_INCOMPLETE":
      return {
        cause: "The last scan completed without evaluating the target.",
        effect:
          "There is no evidence to judge — this is not a clean result and no launch decision is possible.",
        recovery: "Review the scan's coverage details, then re-run the review.",
        recoveryHref: "/dashboard/scans",
      }
    default: {
      // An unmapped code keeps the server's own sentence as the cause so the two
      // surfaces agree, but never keeps the generic effect/recovery pair when a
      // sanitized sentence was available: a server refusal and a lost response
      // are different outcomes and must not read the same.
      const serverCause = sanitizeServerMessage(context.serverMessage)
      if (!serverCause) {
        return {
          cause: "The request did not complete. Check its status before starting another action.",
          effect: "This message does not establish the final outcome of any work already accepted.",
          recovery:
            "Review the latest status before retrying or contact support if it remains unclear.",
        }
      }
      return {
        cause: serverCause,
        effect: "This message does not establish the final outcome of any work already accepted.",
        recovery:
          "Review the latest status before starting another action. If it stays unclear, contact support.",
      }
    }
  }
}
