import type { CustomerScanUsageProjection } from "@lyrashield/db"

const PROPOSED_REVIEW = {
  goal: "LAUNCH_REVIEW",
  mode: "STANDARD",
  workflow: "REVIEW_TARGET",
} as const

// URL/API launch admits only the deterministic tier, so a proposed review for
// those targets must never point at a removed engine profile.
const PROPOSED_URL_REVIEW = {
  goal: "LAUNCH_REVIEW",
  mode: "SAFE",
  workflow: "REVIEW_TARGET",
} as const

function proposedReviewFor(targetType: string) {
  return targetType === "WEB_APP" || targetType === "API" ? PROPOSED_URL_REVIEW : PROPOSED_REVIEW
}

export type ResourceResult<T> =
  { status: "available"; value: T } | { status: "unavailable"; code: string }

export interface TargetAssessmentGate {
  verdictId: string
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  historicalState: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  applicable: boolean
  reasons: Array<{ code: string; message: string }>
  assessedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  evaluatedAt: string
  coverageStatement: string[]
  nonCoverage: Array<{ controlId: string; scanner: string; reason: string | null }>
}

export interface TargetRemediationCounts {
  newFindings: number
  recurringFindings: number
  resolvedFindings: number
  uncertainMatches: number
  blockingFindings: number
}

export interface TargetAssessmentSource {
  target: {
    id: string
    name: string
    type: string
    environment: string | null
  }
  canStartScan: boolean
  latestScan: {
    id: string
    status: string
    goal: string
    mode: string
    createdAt: string
    startedAt: string | null
    endedAt: string | null
    sourceRevision: string | null
  } | null
  gate: ResourceResult<TargetAssessmentGate | null>
  remediation: ResourceResult<TargetRemediationCounts>
  spend: ResourceResult<CustomerScanUsageProjection | null>
}

export interface TargetAssessmentProjection {
  proposedReview: typeof PROPOSED_REVIEW | typeof PROPOSED_URL_REVIEW
  target: TargetAssessmentSource["target"]
  assessment: TargetAssessmentGate | null
  assessmentState: ResourceResult<TargetAssessmentGate | null>["status"]
  assessmentUnavailableCode: string | null
  execution: {
    latestScanId: string | null
    status: string | null
    sourceRevision: string | null
    startedAt: string | null
    endedAt: string | null
    deliveryState: "UNKNOWN" | "QUEUED" | "RUNNING" | "TERMINAL"
  }
  coverage: ResourceResult<{
    complete: boolean
    coverageStatement: string[]
    nonCoverage: TargetAssessmentGate["nonCoverage"]
  }>
  remediation: ResourceResult<TargetRemediationCounts>
  spend: ResourceResult<CustomerScanUsageProjection | null>
  nextAction: {
    code:
      | "START_REVIEW"
      | "VIEW_RUNNING_REVIEW"
      | "REFRESH_ASSESSMENT"
      | "REVIEW_BLOCKERS"
      | "COMPLETE_COVERAGE"
      | "CREATE_RELEASE_PACKET"
      | "RECOVER_ACCESS"
    label: string
    href: string
  }
}

const ACTIVE_SCAN_STATUSES = new Set([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
])

function deliveryState(status: string | undefined): "UNKNOWN" | "QUEUED" | "RUNNING" | "TERMINAL" {
  if (!status) return "UNKNOWN"
  if (status === "QUEUED") return "QUEUED"
  if (ACTIVE_SCAN_STATUSES.has(status)) return "RUNNING"
  return "TERMINAL"
}

function reviewHref(
  targetId: string,
  intent: typeof PROPOSED_REVIEW | typeof PROPOSED_URL_REVIEW
): string {
  return `/dashboard/scans?${new URLSearchParams({
    new: "1",
    target: targetId,
    goal: intent.goal,
    mode: intent.mode,
  }).toString()}`
}

/**
 * Pure customer-facing projection. The stored gate verdict remains the sole
 * source of the readiness state; this function only explains it and chooses a
 * permitted next action. It deliberately has no percentage/progress estimate.
 */
export function projectTargetAssessment(input: TargetAssessmentSource): TargetAssessmentProjection {
  const gate = input.gate.status === "available" ? input.gate.value : null
  const coverage: TargetAssessmentProjection["coverage"] =
    input.gate.status === "unavailable"
      ? { status: "unavailable", code: input.gate.code }
      : gate
        ? {
            status: "available",
            value: {
              complete: gate.applicable && gate.nonCoverage.length === 0,
              coverageStatement: gate.coverageStatement,
              nonCoverage: gate.nonCoverage,
            },
          }
        : {
            status: "available",
            value: { complete: false, coverageStatement: [], nonCoverage: [] },
          }

  const executionState = deliveryState(input.latestScan?.status)
  const proposedReview = proposedReviewFor(input.target.type)
  let nextAction: TargetAssessmentProjection["nextAction"]
  if (executionState === "QUEUED" || executionState === "RUNNING") {
    nextAction = {
      code: "VIEW_RUNNING_REVIEW",
      label: "View running review",
      href: `/dashboard/scans/${encodeURIComponent(input.latestScan!.id)}`,
    }
  } else if (!input.canStartScan) {
    nextAction = {
      code: "RECOVER_ACCESS",
      label: "Recover workspace access",
      href: "/dashboard/connections",
    }
  } else if (input.gate.status === "unavailable") {
    nextAction = {
      code: "REFRESH_ASSESSMENT",
      label: "Refresh assessment",
      href: `/dashboard/targets/${encodeURIComponent(input.target.id)}`,
    }
  } else if (!gate) {
    nextAction = {
      code: "START_REVIEW",
      label: "Start launch review",
      href: reviewHref(input.target.id, proposedReview),
    }
  } else if (gate.state === "NOT_READY") {
    nextAction = {
      code: "REVIEW_BLOCKERS",
      label: "Review blocking findings",
      href: `/dashboard/findings?target=${encodeURIComponent(input.target.id)}`,
    }
  } else if (gate.state === "INSUFFICIENT_EVIDENCE" || !gate.applicable) {
    nextAction = {
      code: "COMPLETE_COVERAGE",
      label: "Run a current review",
      href: reviewHref(input.target.id, PROPOSED_REVIEW),
    }
  } else {
    const identity = gate.assessedIdentity
    const packetParams = new URLSearchParams({ targetId: input.target.id })
    if (identity?.kind === "COMMIT") packetParams.set("commit", identity.value)
    if (identity?.kind === "ARTIFACT_DIGEST") packetParams.set("artifactDigest", identity.value)
    nextAction = {
      code: "CREATE_RELEASE_PACKET",
      label: "Create release packet",
      href: `/dashboard/reports/release-packet/new?${packetParams.toString()}`,
    }
  }

  return {
    proposedReview,
    target: input.target,
    assessment: gate,
    assessmentState: input.gate.status,
    assessmentUnavailableCode: input.gate.status === "unavailable" ? input.gate.code : null,
    execution: {
      latestScanId: input.latestScan?.id ?? null,
      status: input.latestScan?.status ?? null,
      sourceRevision: input.latestScan?.sourceRevision ?? null,
      startedAt: input.latestScan?.startedAt ?? null,
      endedAt: input.latestScan?.endedAt ?? null,
      deliveryState: executionState,
    },
    coverage,
    remediation: input.remediation,
    spend: input.spend,
    nextAction,
  }
}
