/**
 * W3-03: one remediation timeline assembled purely from stored receipts.
 *
 * Every entry traces to a stored row (fix proposal, PR record, retest,
 * verification receipt, or a versioned human disposition). Nothing is
 * inferred: PR creation is not "applied", engine absence is not "verified",
 * and a closed-unmerged PR stays closed-unmerged. Accepted-risk and
 * false-positive dispositions render as their own entries — they are human
 * dispositions, never technical verification.
 *
 * The timeline is complete by construction: no display pagination may
 * truncate decision evidence, so callers pass all stored rows and this
 * module never truncates them.
 */

export type RemediationTimelineEventKind =
  | "PROPOSED"
  | "PR_OPENED"
  | "PR_MERGED"
  | "PR_CLOSED_UNMERGED"
  | "RETEST_PASSED"
  | "RETEST_FAILED"
  | "RETEST_INCONCLUSIVE"
  | "VERIFIED"
  | "DISPOSITION"

export interface RemediationTimelineEvent {
  kind: RemediationTimelineEventKind
  label: string
  at: string
  detail?: string
  tone: "neutral" | "primary" | "success" | "warning" | "destructive"
}

export interface TimelineFixProposal {
  id: string
  status: string
  summary: string
  createdAt: string
  pullRequests: {
    id: string
    status: string
    prNumber: number | null
    prUrl: string | null
    createdAt: string
    mergedAt: string | null
    closedAt: string | null
  }[]
}

export interface TimelineRetest {
  id: string
  status: string
  resultAfter: string | null
  scanId: string
  createdAt: string
}

export interface TimelineFinding {
  status: string
  verified: boolean
  verificationStatus: string
  verificationMethod?: string | null
  verifiedAt?: string | null
  disposition?: string | null
  dispositionAt?: string | null
  dispositionReason?: string | null
  lastSeenAt: string
}

/** Proposal statuses that were actually surfaced to the user. */
const PROPOSAL_STATUSES = new Set(["draft", "approved", "pr_opened", "pr_merged", "pr_closed"])

export function buildRemediationTimeline(
  finding: TimelineFinding,
  proposals: TimelineFixProposalInput[],
  retests: TimelineRetestInput[]
): RemediationTimelineEvent[] {
  const events: RemediationTimelineEvent[] = []

  for (const proposal of proposals) {
    if (!PROPOSAL_STATUSES.has(proposal.status)) continue
    events.push({
      kind: "PROPOSED",
      label: "Fix proposed",
      at: proposal.createdAt,
      detail: proposal.summary,
      tone: "neutral",
    })
    for (const pr of proposal.pullRequests) {
      events.push({
        kind: "PR_OPENED",
        label: "Fix PR opened",
        at: pr.createdAt,
        detail: pr.prUrl ? `PR #${pr.prNumber ?? ""}`.trimEnd() : pr.branchName,
        tone: "primary",
      })
      // Truthful merge state: a merged PR is the only "applied" evidence this
      // timeline accepts; a closed-unmerged PR is shown as exactly that.
      if (pr.mergedAt) {
        events.push({
          kind: "PR_MERGED",
          label: "Fix PR merged",
          at: pr.mergedAt,
          detail: pr.prUrl ? `PR #${pr.prNumber ?? ""}`.trimEnd() : pr.branchName,
          tone: "primary",
        })
      } else if (pr.closedAt) {
        events.push({
          kind: "PR_CLOSED_UNMERGED",
          label: "Fix PR closed without merging",
          at: pr.closedAt,
          detail: "No code was applied from this PR.",
          tone: "warning",
        })
      }
    }
  }

  for (const retest of retests) {
    // Only terminal retest states are receipts; pending/running rows are not
    // timeline evidence yet.
    if (retest.status === "passed") {
      events.push({
        kind: "RETEST_PASSED",
        label: "Retest passed",
        at: retest.createdAt,
        detail: `Retest scan ${retest.scanId}`,
        tone: "success",
      })
    } else if (retest.status === "failed") {
      events.push({
        kind: "RETEST_FAILED",
        label: "Retest did not confirm the fix",
        at: retest.createdAt,
        detail: "The finding was still detected; the fix is not verified.",
        tone: "destructive",
      })
    } else if (retest.status === "error") {
      events.push({
        kind: "RETEST_INCONCLUSIVE",
        label: "Retest inconclusive",
        at: retest.createdAt,
        detail: "The retest could not establish the finding's state.",
        tone: "warning",
      })
    }
  }

  // Verification is a stored receipt state, never inferred from engine
  // absence: only VERIFIED/VALIDATED verification statuses produce it. The
  // timestamp prefers the verifying receipt's time when the caller has one.
  if (finding.verificationStatus === "VERIFIED" || finding.verificationStatus === "VALIDATED") {
    events.push({
      kind: "VERIFIED",
      label: "Independently verified",
      at: finding.verifiedAt ?? finding.dispositionAt ?? finding.lastSeenAt,
      detail: finding.verificationMethod ? `Method: ${finding.verificationMethod}` : undefined,
      tone: "success",
    })
  }

  // Human dispositions are separate timeline entries, never folded into a
  // technical verification state.
  if (finding.status === "ACCEPTED_RISK" || finding.status === "FALSE_POSITIVE") {
    events.push({
      kind: "DISPOSITION",
      label: finding.status === "ACCEPTED_RISK" ? "Risk accepted" : "Marked false positive",
      at: finding.dispositionAt ?? finding.lastSeenAt,
      detail: finding.dispositionReason ?? undefined,
      tone: "neutral",
    })
  }

  return events.sort(
    (left, right) =>
      new Date(left.at).getTime() - new Date(right.at).getTime() ||
      EVENT_ORDER[left.kind] - EVENT_ORDER[right.kind]
  )
}

const EVENT_ORDER: Record<RemediationTimelineEventKind, number> = {
  PROPOSED: 0,
  PR_OPENED: 1,
  PR_MERGED: 2,
  PR_CLOSED_UNMERGED: 3,
  RETEST_PASSED: 4,
  RETEST_FAILED: 5,
  RETEST_INCONCLUSIVE: 6,
  VERIFIED: 7,
  DISPOSITION: 8,
}

export interface TimelineFixProposalInput {
  id: string
  status: string
  summary: string
  createdAt: string
  pullRequests: TimelinePullRequestInput[]
}

export interface TimelinePullRequestInput {
  id: string
  status: string
  prNumber: number | null
  prUrl: string | null
  branchName: string
  createdAt: string
  mergedAt: string | null
  closedAt: string | null
}

export interface TimelineRetestInput {
  id: string
  status: string
  scanId: string
  createdAt: string
}
