export type FindingNextStep = "REPORT" | "RETEST_IN_PROGRESS" | "FIX_PROPOSAL" | "RETEST"

export function getFindingNextStep({
  latestRetestStatus,
  hasFixProposal,
}: {
  latestRetestStatus?: string | null
  hasFixProposal: boolean
}): FindingNextStep {
  if (latestRetestStatus === "passed") return "REPORT"
  if (latestRetestStatus && ["pending", "running"].includes(latestRetestStatus)) {
    return "RETEST_IN_PROGRESS"
  }
  return hasFixProposal ? "RETEST" : "FIX_PROPOSAL"
}

export interface FindingNextActionInput {
  latestRetestStatus?: string | null
  hasFixProposal: boolean
  /** Canonical finding status (OPEN, FIX_READY, PR_OPENED, FIXED, dispositions...). */
  status?: string | null
  /** Whether the finding carries usable fix evidence (implicated files/patch). */
  hasFixEvidence?: boolean
  /** Whether a durable operation for this finding is already running. */
  operationInFlight?: boolean
}

export interface FindingAction {
  action: FindingNextStep | "INSPECT_EVIDENCE" | "OPEN_PR" | "NONE"
  /** Why this action (or no action) is possible. Never a claim of exploitability. */
  reason: string
}

/**
 * One next action per finding (W3-02), from the canonical workflow, evidence,
 * and disposition state. Missing source, patch, grant, or coverage never
 * offers an executable action; an in-flight operation returns its status
 * instead of starting another.
 */
export function getFindingNextAction(input: {
  latestRetestStatus?: string | null
  hasFixProposal: boolean
  status?: string | null
  hasEvidence?: boolean
  operationInFlight?: boolean
}): { action: FindingNextStep | "INSPECT_EVIDENCE" | "OPEN_PR" | "NONE"; reason: string } {
  if (input.operationInFlight) {
    return { action: "INSPECT_EVIDENCE", reason: "An operation for this finding is already running. Its status is the next step." }
  }
  const status = input.status
  if (status === "FALSE_POSITIVE" || status === "DUPLICATE") {
    return { action: "NONE", reason: "This finding is dispositioned; no further action is required." }
  }
  if (status === "ACCEPTED_RISK") {
    return { action: "NONE", reason: "Risk was accepted by a human decision; the record stays auditable." }
  }
  if (status === "FIXED") {
    return { action: "NONE", reason: "A trusted retest receipt verified this fix." }
  }
  if (status === "FIXED_PENDING_RETEST") {
    return { action: "RETEST", reason: "The fix is applied; a deterministic retest must confirm it before FIXED." }
  }
  if (input.hasFixProposal === false && input.latestRetestStatus !== "passed" && input.hasEvidence) {
    return { action: "INSPECT_EVIDENCE", reason: "Review the retained evidence before choosing remediation." }
  }
  const step = getFindingNextStep(input)
  switch (step) {
    case "REPORT":
      return { action: "REPORT", reason: "A passing retest is on record; package the evidence into a report." }
    case "RETEST_IN_PROGRESS":
      return { action: "RETEST_IN_PROGRESS", reason: "A retest is running; its receipt will update this finding." }
    case "FIX_PROPOSAL":
      return { action: "FIX_PROPOSAL", reason: "Generate a fix proposal from the retained evidence." }
    case "RETEST":
      return { action: "RETEST", reason: "A fix proposal exists; retest to confirm or refute it." }
  }
}
