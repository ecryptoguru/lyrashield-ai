import {
  classifyRetestResolution,
  getCurrentGateVerdict,
  getCustomerScanUsageProjection,
  loadReceiptBackedRetestFindingIds,
  parseAssessmentSnapshot,
  withWorkspaceRLS,
  type ScopedTransaction,
} from "@lyrashield/db"
import type {
  ResourceResult,
  TargetAssessmentGate,
  TargetRemediationCounts,
} from "./target-assessment"

interface PanelInput {
  workspaceId: string
  targetId: string
  actorUserId: string
  latestScanId: string | null
  latestScanStartedAt: Date | null
}

export interface TargetAssessmentPanels {
  gate: ResourceResult<TargetAssessmentGate | null>
  remediation: ResourceResult<TargetRemediationCounts>
  spend: ResourceResult<Awaited<ReturnType<typeof getCustomerScanUsageProjection>>>
}

interface PanelLoaders {
  loadGate: (input: PanelInput) => Promise<TargetAssessmentGate | null>
  loadRemediation: (input: PanelInput) => Promise<TargetRemediationCounts>
  loadSpend: (
    input: PanelInput
  ) => Promise<Awaited<ReturnType<typeof getCustomerScanUsageProjection>>>
}

interface RemediationFindingInput {
  severity: string
  status: string
  firstSeenAt: Date
  lastSeenAt: Date
  observedInCurrentScan: boolean
  trustedRetest?: boolean
}

const BLOCKING_STATUSES = new Set([
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
])

export function countTargetRemediation(
  findings: RemediationFindingInput[],
  currentScanStartedAt: Date | null
): TargetRemediationCounts {
  const counts: TargetRemediationCounts = {
    newFindings: 0,
    recurringFindings: 0,
    resolvedFindings: 0,
    uncertainMatches: 0,
    blockingFindings: 0,
  }
  for (const finding of findings) {
    if (
      (finding.severity === "CRITICAL" || finding.severity === "HIGH") &&
      BLOCKING_STATUSES.has(finding.status)
    ) {
      counts.blockingFindings++
    }
    const resolution = classifyRetestResolution(finding.status, finding.trustedRetest === true)
    if (resolution) {
      if (resolution === "resolved") counts.resolvedFindings++
      else counts.uncertainMatches++
      continue
    }
    if (!finding.observedInCurrentScan) {
      if (!currentScanStartedAt || finding.lastSeenAt >= currentScanStartedAt) {
        counts.uncertainMatches++
      }
      continue
    }
    if (!currentScanStartedAt) {
      counts.uncertainMatches++
    } else if (finding.firstSeenAt >= currentScanStartedAt) {
      counts.newFindings++
    } else {
      counts.recurringFindings++
    }
  }
  return counts
}

function historicalState(value: string): TargetAssessmentGate["historicalState"] {
  return value === "READY" || value === "NOT_READY" || value === "INSUFFICIENT_EVIDENCE"
    ? value
    : "INSUFFICIENT_EVIDENCE"
}

function gateNonCoverage(value: unknown): TargetAssessmentGate["nonCoverage"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const controlId = item.controlId
    const scanner = item.scanner
    const reason = item.reason
    return typeof controlId === "string" &&
      typeof scanner === "string" &&
      (reason === null || typeof reason === "string")
      ? [{ controlId, scanner, reason }]
      : []
  })
}

async function defaultLoadGate(input: PanelInput): Promise<TargetAssessmentGate | null> {
  const result = await getCurrentGateVerdict(input.workspaceId, input.targetId)
  if (!result) return null
  const historical = result.historical
  return {
    verdictId: historical.id,
    state: result.state,
    historicalState: historicalState(historical.state),
    applicable: result.applicability.applicable,
    reasons: result.applicability.reasons,
    assessedIdentity: parseAssessmentSnapshot(historical.assessmentSnapshot)?.identity ?? null,
    evaluatedAt: historical.evaluatedAt.toISOString(),
    coverageStatement: Array.isArray(historical.coverageStatement)
      ? historical.coverageStatement.flatMap((item): string[] =>
          typeof item === "string" ? [item] : []
        )
      : [],
    nonCoverage: gateNonCoverage(historical.nonCoverage),
  }
}

function withAssessmentSnapshot<T>(workspaceId: string, fn: (tx: ScopedTransaction) => Promise<T>) {
  return withWorkspaceRLS(workspaceId, fn, { isolationLevel: "RepeatableRead" })
}

async function defaultLoadRemediation(input: PanelInput): Promise<TargetRemediationCounts> {
  const findings = await withAssessmentSnapshot(input.workspaceId, async (tx) => {
    const rows = await tx.finding.findMany({
      where: { workspaceId: input.workspaceId, targetId: input.targetId, deletedAt: null },
      select: {
        id: true,
        scanId: true,
        dedupeKey: true,
        severity: true,
        status: true,
        firstSeenAt: true,
        lastSeenAt: true,
        verificationReceipts: {
          where: { method: "RETEST" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            status: true,
            method: true,
            scanId: true,
            verifierVersion: true,
            evidence: true,
          },
        },
        candidates: input.latestScanId
          ? { where: { scanId: input.latestScanId }, select: { id: true }, take: 1 }
          : false,
      },
    })
    const trusted = await loadReceiptBackedRetestFindingIds(tx, {
      workspaceId: input.workspaceId,
      targetId: input.targetId,
      findings: rows.filter((finding) => finding.status === "FIXED"),
    })
    return rows.map((finding) => ({ ...finding, trustedRetest: trusted.has(finding.id) }))
  })
  return countTargetRemediation(
    findings.map((finding) => ({
      severity: finding.severity,
      status: finding.status,
      firstSeenAt: finding.firstSeenAt,
      lastSeenAt: finding.lastSeenAt,
      trustedRetest: finding.trustedRetest,
      observedInCurrentScan: Array.isArray(finding.candidates) && finding.candidates.length > 0,
    })),
    input.latestScanStartedAt
  )
}

async function defaultLoadSpend(input: PanelInput) {
  if (!input.latestScanId) return null
  return getCustomerScanUsageProjection({
    workspaceId: input.workspaceId,
    scanId: input.latestScanId,
    actorUserId: input.actorUserId,
  })
}

function unavailable<T>(code: string): ResourceResult<T> {
  return { status: "unavailable", code }
}

/**
 * Run independent target panels under Promise.allSettled. A failed panel is
 * unavailable; it never becomes an empty/clean state and never breaks peers.
 */
export async function loadTargetAssessmentPanels(
  input: PanelInput,
  loaders: PanelLoaders = {
    loadGate: defaultLoadGate,
    loadRemediation: defaultLoadRemediation,
    loadSpend: defaultLoadSpend,
  }
): Promise<TargetAssessmentPanels> {
  const [gate, remediation, spend] = await Promise.allSettled([
    loaders.loadGate(input),
    loaders.loadRemediation(input),
    loaders.loadSpend(input),
  ])
  return {
    gate:
      gate.status === "fulfilled"
        ? { status: "available", value: gate.value }
        : unavailable("GATE_UNAVAILABLE"),
    remediation:
      remediation.status === "fulfilled"
        ? { status: "available", value: remediation.value }
        : unavailable("REMEDIATION_UNAVAILABLE"),
    spend:
      spend.status === "fulfilled"
        ? { status: "available", value: spend.value }
        : unavailable("SPEND_UNAVAILABLE"),
  }
}
