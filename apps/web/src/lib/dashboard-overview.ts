import { prisma } from "@lyrashield/db"
import type { ScanStatus, FindingSeverity, FindingStatus, ScoreGrade } from "@lyrashield/db"
import type { ReadinessVerdict } from "./launch-readiness"

/**
 * Server-side dashboard read model.
 *
 * Every headline on Home is derived from ONE coherent evidence scope instead of
 * independently-selected workspace aggregates (which could describe different
 * scans, targets, and dates on the same screen). Scores are bound to the scan
 * that produced them through ScoreSnapshot.scanId, coverage is computed per
 * active target from that target's applicable terminal runs and coverage
 * receipts, and the workspace verdict refuses a positive state while any active
 * target lacks usable, non-expired evidence.
 */

export type DashboardCoverageState = "NONE" | "PARTIAL" | "COMPLETE"

export interface DashboardOverview {
  targets: {
    total: number
    assessed: number
    partiallyAssessed: number
    unassessed: number
    expiredAssessments: number
  }
  openIssues: {
    total: number
    critical: number
    high: number
    independentlyVerified: number
  }
  /** Open-issue severity mix for the workspace-wide donut. */
  openIssuesBySeverity: Record<string, number>
  /** Full severity/status/verified groups; feeds the readiness aggregate. */
  findingGroups: DashboardFindingGroup[]
  /** Terminal runs that produced a usable result (COMPLETED or PARTIAL). */
  completedRunCount: number
  /**
   * Recent score snapshots, each bound to the scan that produced it. The trend
   * never mixes scores from runs that evaluated nothing into the line.
   */
  scoreHistory: {
    scanId: string
    score: number
    grade: string
    computedAt: string
    targetName: string | null
  }[]
  reportCount: number
  project: { name: string; riskScore: number; trustPlan: unknown } | null
  latestRun: {
    id: string
    targetId: string | null
    targetName: string | null
    status: string
    mode: string
    createdAt: string
    endedAt: string | null
    coverageState: DashboardCoverageState
    /** User-safe failure summary; never raw engine/provider internals. */
    userSafeFailure: string | null
  } | null
  lastEvaluatedAssessment: {
    scanId: string
    targetId: string
    targetName: string
    mode: string
    completedAt: string
    coverageState: "PARTIAL" | "COMPLETE"
    score: number | null
    grade: string | null
    scoreExpiresAt: string | null
  } | null
  recentRuns: DashboardRecentRun[]
  remediation: {
    fixed: number
    inProgress: number
    riskAccepted: number
  }
}

export interface DashboardRecentRun {
  id: string
  targetName: string | null
  status: string
  mode: string
  createdAt: string
  endedAt: string | null
  findingCount: number
}

const TERMINAL_RUN_STATUSES: ScanStatus[] = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
]

/** Receipt statuses that mean the scanner actually applied to this target. */
const APPLICABLE_RECEIPT_STATUSES = new Set([
  "COMPLETED",
  "PARTIAL",
  "BLOCKED",
  "TIMED_OUT",
  "FAILED",
])

/**
 * Coverage state for one run from its coverage-receipt statuses.
 *
 * NOT_APPLICABLE receipts are excluded first: a scanner that does not apply to
 * the target says nothing about coverage. With no applicable receipts the run
 * checked nothing (NONE). Any applicable receipt that did not complete makes
 * the run PARTIAL; only when every applicable receipt completed is the run's
 * coverage COMPLETE.
 */
export function coverageStateFromReceipts(receiptStatuses: string[]): DashboardCoverageState {
  const applicable = receiptStatuses.filter((status) => APPLICABLE_RECEIPT_STATUSES.has(status))
  if (applicable.length === 0) return "NONE"
  return applicable.every((status) => status === "COMPLETED") ? "COMPLETE" : "PARTIAL"
}

export interface DashboardTargetVerdictInput {
  total: number
  assessed: number
  partiallyAssessed: number
  unassessed: number
  expiredAssessments: number
}

/**
 * Whether the workspace verdict may present a positive (GO-family) state.
 *
 * A clean finding sheet is not a launch verdict while any active target has no
 * usable evidence, or its most recent evaluated evidence has expired. Absence
 * of findings is never independent verification, and an unassessed target is
 * absence of evidence for that target.
 */
export function workspaceEvidenceIsComplete(targets: DashboardTargetVerdictInput): boolean {
  if (targets.total === 0) return false
  return (
    targets.partiallyAssessed === 0 && targets.unassessed === 0 && targets.expiredAssessments === 0
  )
}

/**
 * Downgrade a findings-based readiness verdict to NOT_EVALUATED when the
 * workspace's target coverage does not support a positive launch decision.
 * GO_WITH_CONDITIONS is also refused: "conditions" still reads as approval.
 */
export function applyTargetCoverageToVerdict(
  verdict: ReadinessVerdict,
  targets: DashboardTargetVerdictInput
): { verdict: ReadinessVerdict; coverageCondition: string | null } {
  if (
    (verdict === "GO" || verdict === "GO_WITH_CONDITIONS") &&
    !workspaceEvidenceIsComplete(targets)
  ) {
    const parts: string[] = []
    if (targets.unassessed > 0) {
      parts.push(
        `${targets.unassessed} of ${targets.total} target${targets.total === 1 ? "" : "s"} ${targets.unassessed === 1 ? "has" : "have"} no usable review evidence yet`
      )
    }
    if (targets.partiallyAssessed > 0) {
      parts.push(
        `${targets.partiallyAssessed} target${targets.partiallyAssessed === 1 ? " has" : "s have"} only partial review evidence`
      )
    }
    if (targets.expiredAssessments > 0) {
      parts.push(
        `${targets.expiredAssessments} target${targets.expiredAssessments === 1 ? "'s" : "s'"} most recent score has expired`
      )
    }
    return {
      verdict: "NOT_EVALUATED",
      coverageCondition: `Run a review for every target before a launch decision: ${parts.join("; ")}.`,
    }
  }
  return { verdict, coverageCondition: null }
}

export interface ScanRowLike {
  id: string
  targetId: string | null
  status: string
  mode: string
  createdAt: Date
  endedAt: Date | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  target: { id: string; name: string } | null
  _count?: { findings?: number } | null
}

export interface DashboardFindingGroup {
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  count: number
}

const OPEN_ISSUE_EXCLUDED_STATUSES = new Set(["FIXED", "FALSE_POSITIVE", "DUPLICATE"])

/**
 * Build the overview from pre-fetched rows. Split from the query function so
 * the joining/binding rules are unit-testable without a database.
 */
export function buildDashboardOverview(input: {
  targets: { id: string; name: string }[]
  terminalRuns: ScanRowLike[]
  receiptsByScanId: Map<string, string[]>
  findingGroups: DashboardFindingGroup[]
  /** Presentation supplements; the query function always supplies them. */
  completedRunCount?: number
  reportCount?: number
  project?: { name: string; riskScore: number; trustPlan: unknown } | null
  evaluatedCandidates: {
    scanId: string
    targetId: string
    targetName: string
    mode: string
    completedAt: Date
    score: number
    grade: ScoreGrade
    expiresAt: Date
    receiptStatuses: string[]
  }[]
  scoreHistory?: {
    scanId: string
    score: number
    grade: string
    computedAt: Date
    targetName: string | null
  }[]
  now?: Date
}): DashboardOverview {
  const now = input.now ?? new Date()
  const completedRunCount = input.completedRunCount ?? 0
  const reportCount = input.reportCount ?? 0
  const project = input.project ?? null
  const scoreHistory = input.scoreHistory ?? []

  // One finding-group source feeds open-issue totals, the severity mix,
  // remediation movement, and the readiness aggregate — so every number on the
  // dashboard describes the same workspace-wide issue set.
  const openIssues = { total: 0, critical: 0, high: 0, independentlyVerified: 0 }
  const openIssuesBySeverity: Record<string, number> = {}
  const remediation = { fixed: 0, inProgress: 0, riskAccepted: 0 }
  for (const group of input.findingGroups) {
    if (!OPEN_ISSUE_EXCLUDED_STATUSES.has(group.status)) {
      openIssues.total += group.count
      openIssuesBySeverity[group.severity] =
        (openIssuesBySeverity[group.severity] ?? 0) + group.count
      if (group.severity === "CRITICAL") openIssues.critical += group.count
      if (group.severity === "HIGH") openIssues.high += group.count
      if (group.verified) openIssues.independentlyVerified += group.count
    }
    if (group.status === "FIXED") remediation.fixed += group.count
    if (group.status === "ACCEPTED_RISK") remediation.riskAccepted += group.count
    if (
      ["FIX_READY", "PR_OPENED", "TICKET_CREATED", "FIXED_PENDING_RETEST"].includes(group.status)
    ) {
      remediation.inProgress += group.count
    }
  }

  // A newer inconclusive run does not erase older usable evidence. Track the
  // newest terminal run with applicable coverage for each active target.
  const latestUsableRunByTarget = new Map<string, ScanRowLike>()
  for (const run of input.terminalRuns) {
    if (!run.targetId) continue
    if (coverageStateFromReceipts(input.receiptsByScanId.get(run.id) ?? []) === "NONE") continue
    const existing = latestUsableRunByTarget.get(run.targetId)
    if (!existing || run.createdAt > existing.createdAt)
      latestUsableRunByTarget.set(run.targetId, run)
  }

  const activeTargetIds = new Set(input.targets.map((target) => target.id))
  const latestEvaluatedByTarget = new Map<string, (typeof input.evaluatedCandidates)[number]>()
  for (const candidate of input.evaluatedCandidates) {
    if (!activeTargetIds.has(candidate.targetId)) continue
    if (coverageStateFromReceipts(candidate.receiptStatuses) === "NONE") continue
    const existing = latestEvaluatedByTarget.get(candidate.targetId)
    if (!existing || candidate.completedAt > existing.completedAt) {
      latestEvaluatedByTarget.set(candidate.targetId, candidate)
    }
  }

  let assessed = 0
  let partiallyAssessed = 0
  let unassessed = 0
  for (const target of input.targets) {
    const run = latestUsableRunByTarget.get(target.id)
    const evaluatedCandidate = latestEvaluatedByTarget.get(target.id)
    const state = run
      ? coverageStateFromReceipts(input.receiptsByScanId.get(run.id) ?? [])
      : evaluatedCandidate
        ? coverageStateFromReceipts(evaluatedCandidate.receiptStatuses)
        : "NONE"
    if (state === "COMPLETE") assessed++
    else if (state === "PARTIAL") partiallyAssessed++
    else unassessed++
  }

  const expiredAssessments = [...latestEvaluatedByTarget.values()].filter(
    (candidate) => candidate.expiresAt <= now
  ).length

  const latestRunRow = input.terminalRuns.length
    ? input.terminalRuns.reduce((newest, run) => (run.createdAt > newest.createdAt ? run : newest))
    : null
  const latestRun: DashboardOverview["latestRun"] = latestRunRow
    ? {
        id: latestRunRow.id,
        targetId: latestRunRow.targetId,
        targetName: latestRunRow.target?.name ?? null,
        status: latestRunRow.status,
        mode: latestRunRow.mode,
        createdAt: latestRunRow.createdAt.toISOString(),
        endedAt: latestRunRow.endedAt?.toISOString() ?? null,
        coverageState: coverageStateFromReceipts(input.receiptsByScanId.get(latestRunRow.id) ?? []),
        userSafeFailure:
          latestRunRow.status === "FAILED" ||
          latestRunRow.status === "STOPPED_BUDGET" ||
          latestRunRow.status === "TIMED_OUT"
            ? userSafeRunFailure(latestRunRow.status, latestRunRow.errorCategory)
            : null,
      }
    : null

  // The last evaluated assessment is the newest score snapshot whose scan
  // actually evaluated its target (PARTIAL or COMPLETE coverage) — never the
  // newest workspace score taken independently of the run it describes.
  const evaluated = [...latestEvaluatedByTarget.values()].reduce<
    (typeof input.evaluatedCandidates)[number] | null
  >(
    (latest, candidate) =>
      !latest || candidate.completedAt > latest.completedAt ? candidate : latest,
    null
  )
  const lastEvaluatedAssessment: DashboardOverview["lastEvaluatedAssessment"] = evaluated
    ? {
        scanId: evaluated.scanId,
        targetId: evaluated.targetId,
        targetName: evaluated.targetName,
        mode: evaluated.mode,
        completedAt: evaluated.completedAt.toISOString(),
        coverageState: coverageStateFromReceipts(evaluated.receiptStatuses) as
          "PARTIAL" | "COMPLETE",
        score: evaluated.score,
        grade: evaluated.grade,
        scoreExpiresAt: evaluated.expiresAt.toISOString(),
      }
    : null

  const recentRuns: DashboardRecentRun[] = [...input.terminalRuns]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5)
    .map((run) => ({
      id: run.id,
      targetName: run.target?.name ?? null,
      status: run.status,
      mode: run.mode,
      createdAt: run.createdAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      findingCount: run._count?.findings ?? 0,
    }))

  return {
    targets: {
      total: input.targets.length,
      assessed,
      partiallyAssessed,
      unassessed,
      expiredAssessments,
    },
    openIssues,
    openIssuesBySeverity,
    findingGroups: input.findingGroups,
    completedRunCount,
    scoreHistory: scoreHistory
      .filter(
        (entry) =>
          coverageStateFromReceipts(input.receiptsByScanId.get(entry.scanId) ?? []) !== "NONE"
      )
      .map((entry) => ({
        scanId: entry.scanId,
        score: entry.score,
        grade: entry.grade,
        computedAt: entry.computedAt.toISOString(),
        targetName: entry.targetName,
      })),
    reportCount,
    project,
    latestRun,
    lastEvaluatedAssessment,
    recentRuns,
    remediation,
  }
}

/** User-safe failure copy for a terminal run. Never raw engine/provider text. */
export function userSafeRunFailure(status: string, errorCategory: string | null): string {
  switch (status) {
    case "STOPPED_BUDGET":
      return "The run stopped because its protected limit was reached before completing."
    case "TIMED_OUT":
      return "The run timed out before completing. Check the target is reachable and retry."
    case "FAILED":
      return errorCategory === "QUEUE"
        ? "The run could not start because worker capacity was unavailable."
        : "The run failed before producing a complete result."
    default:
      return "The run did not produce a complete result."
  }
}

/**
 * Query the overview for a workspace. Every query is workspace-scoped; run and
 * receipt fetches are bounded so the dashboard cannot fan out unboundedly.
 */
export async function getDashboardOverview(workspaceId: string): Promise<DashboardOverview> {
  const [
    targets,
    terminalRuns,
    findingGroupRows,
    evaluatedSnapshots,
    completedRunCount,
    reportCount,
    project,
  ] = await Promise.all([
    prisma.target.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.scan.findMany({
      where: { workspaceId, deletedAt: null, status: { in: TERMINAL_RUN_STATUSES } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        targetId: true,
        status: true,
        mode: true,
        createdAt: true,
        endedAt: true,
        summary: true,
        errorCategory: true,
        errorMessage: true,
        target: { select: { id: true, name: true } },
        _count: { select: { findings: { where: { deletedAt: null } } } },
      },
    }),
    // One group-by feeds open-issue totals, the severity mix, remediation
    // movement, and the readiness aggregate.
    prisma.finding.groupBy({
      by: ["severity", "status", "verified"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    // Score snapshots joined to their producing scan: the score and the run
    // it describes are one evidence unit, bound by ScoreSnapshot.scanId.
    prisma.scoreSnapshot.findMany({
      where: { workspaceId, scan: { workspaceId, deletedAt: null } },
      orderBy: { computedAt: "desc" },
      take: 20,
      select: {
        scanId: true,
        score: true,
        grade: true,
        expiresAt: true,
        computedAt: true,
        scan: {
          select: {
            mode: true,
            endedAt: true,
            target: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.scan.count({
      where: { workspaceId, deletedAt: null, status: { in: ["COMPLETED", "PARTIAL"] } },
    }),
    prisma.report.count({ where: { workspaceId, deletedAt: null } }),
    prisma.project.findFirst({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { name: true, riskScore: true, trustPlan: true },
    }),
  ])

  const scanIdsInScope = [
    ...new Set([
      ...terminalRuns.map((run) => run.id),
      ...evaluatedSnapshots.map((snapshot) => snapshot.scanId),
    ]),
  ]
  const receipts = scanIdsInScope.length
    ? await prisma.scanCoverageReceipt.findMany({
        where: { scanId: { in: scanIdsInScope }, scan: { workspaceId, deletedAt: null } },
        select: { scanId: true, status: true },
      })
    : []

  const receiptsByScanId = new Map<string, string[]>()
  for (const receipt of receipts) {
    const statuses = receiptsByScanId.get(receipt.scanId)
    if (statuses) statuses.push(receipt.status)
    else receiptsByScanId.set(receipt.scanId, [receipt.status])
  }

  // The 200-run window is newest-first across ALL targets, so a target whose
  // only terminal runs are old can fall outside it entirely — the coverage
  // pass would then classify an assessed target as unassessed. Derive each
  // active target's LATEST terminal run explicitly (bounded by target count,
  // one query) and union it into the run set so the per-target lookup always
  // sees the target's own newest evidence.
  const activeTargetIds = targets.map((target) => target.id)
  const windowScanIds = new Set(terminalRuns.map((run) => run.id))
  const missingTargets = activeTargetIds.filter(
    (id) => !terminalRuns.some((r) => r.targetId === id)
  )
  let perTargetRuns: typeof terminalRuns = []
  if (missingTargets.length > 0) {
    perTargetRuns = await prisma.scan.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: TERMINAL_RUN_STATUSES },
        targetId: { in: missingTargets },
      },
      orderBy: { createdAt: "desc" },
      // One newest run per missing target is all the coverage pass needs; a
      // small per-target cap bounds the fetch while covering receipt variety.
      take: missingTargets.length * 3,
      select: {
        id: true,
        targetId: true,
        status: true,
        mode: true,
        createdAt: true,
        endedAt: true,
        summary: true,
        errorCategory: true,
        errorMessage: true,
        target: { select: { id: true, name: true } },
        _count: { select: { findings: { where: { deletedAt: null } } } },
      },
    })
  }
  const allTerminalRuns = [...terminalRuns, ...perTargetRuns]
  // Add receipts for the per-target runs the window fetch had not covered.
  const extraScanIds = perTargetRuns.map((run) => run.id).filter((id) => !windowScanIds.has(id))
  if (extraScanIds.length) {
    const extraReceipts = await prisma.scanCoverageReceipt.findMany({
      where: { scanId: { in: extraScanIds }, scan: { workspaceId, deletedAt: null } },
      select: { scanId: true, status: true },
    })
    for (const receipt of extraReceipts) {
      const statuses = receiptsByScanId.get(receipt.scanId)
      if (statuses) statuses.push(receipt.status)
      else receiptsByScanId.set(receipt.scanId, [receipt.status])
    }
  }

  const findingGroups: DashboardFindingGroup[] = findingGroupRows.map((group) => ({
    severity: group.severity as FindingSeverity,
    status: group.status as FindingStatus,
    verified: group.verified,
    count: group._count._all,
  }))

  const evaluatedCandidates = evaluatedSnapshots
    .filter((snapshot) => snapshot.scan.endedAt && snapshot.scan.target)
    .map((snapshot) => ({
      scanId: snapshot.scanId,
      targetId: snapshot.scan.target!.id,
      targetName: snapshot.scan.target!.name,
      mode: snapshot.scan.mode,
      completedAt: snapshot.scan.endedAt!,
      score: snapshot.score,
      grade: snapshot.grade,
      expiresAt: snapshot.expiresAt,
      receiptStatuses: receiptsByScanId.get(snapshot.scanId) ?? [],
    }))

  return buildDashboardOverview({
    targets,
    terminalRuns: allTerminalRuns,
    receiptsByScanId,
    findingGroups,
    completedRunCount,
    reportCount,
    project,
    evaluatedCandidates,
    scoreHistory: evaluatedSnapshots.map((snapshot) => ({
      scanId: snapshot.scanId,
      score: snapshot.score,
      grade: snapshot.grade,
      computedAt: snapshot.computedAt,
      targetName: snapshot.scan.target?.name ?? null,
    })),
  })
}
