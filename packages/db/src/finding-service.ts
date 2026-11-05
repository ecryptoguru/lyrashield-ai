import {
  findingScopeWhere,
  targetReadScopeWhere,
  type FindingScopeParams,
} from "./read-query-scope"
export { findingScopeWhere, type FindingScopeParams } from "./read-query-scope"
import { prisma } from "./client"
import type { ScopedTransaction } from "./rls"
import { Prisma } from "./generated/prisma"
import type { Finding, FindingSeverity, FindingStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { buildHistoryPreview, HISTORY_PREVIEW_LIMIT } from "./finding-history-cursor"
import type { FindingHistoryCollection } from "./finding-history-service"

export interface ListFindingsParams {
  workspaceId: string
  targetId?: string
  targetIds?: string[]
  requireActiveTarget?: boolean
  allowedProfiles?: string[]
  /** Filter findings observed in a scan candidate receipt. `scanId` below remains the origin scan. */
  observedInScanId?: string
  scanId?: string
  severity?: FindingSeverity
  status?: FindingStatus
  verified?: boolean
  category?: string
  /** Bounded workspace-scoped search over title, summary, and CWE. */
  q?: string
  cursor?: string
  limit?: number
}

export async function validateFindingScope(
  { workspaceId, targetId, targetIds, observedInScanId }: FindingScopeParams,
  client?: ScopedTransaction
): Promise<
  | { available: true; target: { id: string; name: string } | null; scanId: string | null }
  | { available: false; target: null; scanId: null }
> {
  if (targetId && targetIds !== undefined && !targetIds.includes(targetId)) {
    return { available: false, target: null, scanId: null }
  }
  const db = client ?? prisma
  const [target, scan] = await Promise.all([
    targetId
      ? db.target.findFirst({
          where: { id: targetId, workspaceId, deletedAt: null },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    observedInScanId
      ? db.scan.findFirst({
          where: {
            id: observedInScanId,
            workspaceId,
            deletedAt: null,
            ...targetReadScopeWhere({ targetId, targetIds }),
          },
          select: { id: true, targetId: true },
        })
      : Promise.resolve(null),
  ])

  if ((targetId && !target) || (observedInScanId && !scan)) {
    return { available: false, target: null, scanId: null }
  }

  const resolvedTargetId = targetId ?? scan?.targetId ?? null
  const resolvedTarget =
    target ??
    (resolvedTargetId
      ? await db.target.findFirst({
          where: { id: resolvedTargetId, workspaceId, deletedAt: null },
          select: { id: true, name: true },
        })
      : null)
  if (resolvedTargetId && !resolvedTarget) {
    return { available: false, target: null, scanId: null }
  }

  return {
    available: true,
    target: resolvedTarget,
    scanId: scan?.id ?? null,
  }
}

export interface FindingStats {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  verified: number
  unverified: number
}

type FindingDispositionInput = {
  kind: "ACCEPTED_RISK" | "FALSE_POSITIVE"
  actorUserId: string
}

export async function listFindings(
  params: ListFindingsParams,
  client?: ScopedTransaction
): Promise<{
  items: (Finding & {
    _count?: { evidence: number; fixProposals: number }
    target?: { id: string; name: string; type: string; environment: string | null } | null
  })[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const search = params.q?.trim()
  const db = client ?? prisma
  const where: Record<string, unknown> = {
    ...findingScopeWhere(params),
    ...(params.scanId ? { scanId: params.scanId } : {}),
    ...(params.severity ? { severity: params.severity } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.verified !== undefined ? { verified: params.verified } : {}),
    ...(params.category ? { category: params.category } : {}),
    // Search matches title, summary, and CWE only. It never merges or groups
    // findings — canonical dedupe identity remains the only grouping force.
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { summary: { contains: search, mode: "insensitive" } },
            { cwe: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  }

  const findings = await db.finding.findMany({
    where,
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      target: { select: { id: true, name: true, type: true, environment: true } },
      _count: {
        select: {
          evidence: { where: { redactionStatus: { not: "deleted" } } },
          fixProposals: { where: { deletedAt: null } },
        },
      },
    },
  })

  const hasMore = findings.length > limit
  const items = hasMore ? findings.slice(0, limit) : findings
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}

export async function listEvidenceFindings(
  params: FindingScopeParams & { cursor?: string; limit?: number },
  client?: ScopedTransaction
) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const evidenceWhere = { redactionStatus: "complete" }
  const db = client ?? prisma
  const findings = await db.finding.findMany({
    where: {
      ...findingScopeWhere(params),
      verified: true,
      evidence: { some: evidenceWhere },
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      summary: true,
      target: { select: { id: true, name: true, type: true } },
      evidence: {
        where: evidenceWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { type: true, createdAt: true },
      },
      _count: { select: { evidence: { where: evidenceWhere } } },
    },
  })

  const hasMore = findings.length > limit
  const items = hasMore ? findings.slice(0, limit) : findings
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1]!.id : null,
  }
}

const FINDING_DETAIL_INCLUDE = Prisma.validator<Prisma.FindingInclude>()({
  evidence: {
    where: { redactionStatus: { not: "deleted" } },
    select: { id: true, type: true, redactionStatus: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_PREVIEW_LIMIT + 1,
  },
  verificationReceipts: {
    select: {
      id: true,
      status: true,
      method: true,
      reason: true,
      scanId: true,
      sourceRevision: true,
      verifierVersion: true,
      evidence: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_PREVIEW_LIMIT + 1,
  },
  fixProposals: {
    where: { deletedAt: null },
    select: {
      id: true,
      status: true,
      summary: true,
      createdAt: true,
      diffRef: true,
      pullRequests: {
        where: { deletedAt: null },
        select: {
          id: true,
          status: true,
          prNumber: true,
          prUrl: true,
          branchName: true,
          createdAt: true,
          mergedAt: true,
          closedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_PREVIEW_LIMIT + 1,
  },
  retests: {
    select: { id: true, scanId: true, status: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_PREVIEW_LIMIT + 1,
  },
  _count: {
    select: {
      evidence: { where: { redactionStatus: { not: "deleted" } } },
      verificationReceipts: true,
      fixProposals: { where: { deletedAt: null } },
      retests: true,
    },
  },
})

export async function getFinding(
  findingId: string,
  workspaceId: string,
  scope: Pick<
    FindingScopeParams,
    "targetId" | "targetIds" | "observedInScanId" | "requireActiveTarget" | "allowedProfiles"
  > = {},
  client?: ScopedTransaction
): Promise<
  | (Finding & {
      evidence: { id: string; type: string; redactionStatus: string }[]
      verificationReceipts: {
        id: string
        status: string
        method: string
        reason: string
        scanId: string
        sourceRevision: string | null
        verifierVersion: string | null
        evidence: unknown
        createdAt: Date
      }[]
      fixProposals: {
        id: string
        status: string
        summary: string
        createdAt: Date
        hasStoredPatch: boolean
      }[]
      retests: { id: string; scanId: string; status: string; createdAt: Date }[]
      historyPagination: Record<
        FindingHistoryCollection,
        { total: number; nextCursor: string | null }
      >
    })
  | null
> {
  const db = client ?? prisma
  const finding = await db.finding.findFirst({
    where: { id: findingId, ...findingScopeWhere({ workspaceId, ...scope }) },
    include: FINDING_DETAIL_INCLUDE,
  })
  if (!finding) return null

  const evidence = buildHistoryPreview(
    findingId,
    "evidence",
    finding.evidence,
    finding._count.evidence
  )
  const verificationReceipts = buildHistoryPreview(
    findingId,
    "verificationReceipts",
    finding.verificationReceipts,
    finding._count.verificationReceipts
  )
  const fixProposals = buildHistoryPreview(
    findingId,
    "fixProposals",
    finding.fixProposals,
    finding._count.fixProposals
  )
  const retests = buildHistoryPreview(findingId, "retests", finding.retests, finding._count.retests)

  const { _count, ...baseFinding } = finding
  void _count
  return {
    ...baseFinding,
    evidence: evidence.items,
    verificationReceipts: verificationReceipts.items,
    fixProposals: fixProposals.items.map(({ diffRef, ...proposal }) => ({
      ...proposal,
      hasStoredPatch: Boolean(diffRef),
    })),
    retests: retests.items,
    historyPagination: {
      evidence: evidence.pagination,
      verificationReceipts: verificationReceipts.pagination,
      fixProposals: fixProposals.pagination,
      retests: retests.pagination,
    },
  }
}

export async function getFindingReference(
  findingId: string,
  workspaceId: string,
  client?: ScopedTransaction
) {
  const db = client ?? prisma
  return db.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
    select: {
      id: true,
      scanId: true,
      targetId: true,
      scan: { select: { mode: true } },
    },
  })
}

export async function updateFindingStatus(
  findingId: string,
  workspaceId: string,
  status: FindingStatus,
  reason?: string,
  canonicalFindingId?: string,
  disposition?: FindingDispositionInput
): Promise<Finding> {
  const finding = await prisma.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
  })
  if (!finding) throw new Error(`Finding not found: ${findingId}`)

  // Only the retest pipeline may set the terminal FIXED state. A human or API
  // status change records the claimed remediation, but keeps it in the score
  // until the fresh, server-owned retest validates it.
  const resolvedStatus = status === "FIXED" ? "FIXED_PENDING_RETEST" : status
  const updateData: Record<string, unknown> = { status: resolvedStatus }
  if (resolvedStatus === "FIXED_PENDING_RETEST") {
    updateData.fixedAt = new Date()
  }
  if (reason !== undefined) {
    updateData.statusReason = reason
  }
  if (resolvedStatus === "DUPLICATE") {
    if (!canonicalFindingId || canonicalFindingId === findingId || !finding.targetId) {
      throw new Error(
        "A duplicate finding requires a different canonical finding on the same target"
      )
    }
    const canonical = await prisma.finding.findFirst({
      where: {
        id: canonicalFindingId,
        workspaceId,
        targetId: finding.targetId,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (!canonical) {
      throw new Error("Canonical finding not found on this target")
    }
    updateData.canonicalFindingId = canonical.id
  }
  if (disposition) {
    updateData.disposition = disposition.kind
    updateData.dispositionActorUserId = disposition.actorUserId
    updateData.dispositionReason = reason ?? null
    updateData.dispositionAssessmentId = finding.scanId
    updateData.dispositionAt = new Date()
  }

  const updated = await prisma.finding.update({
    where: { id: findingId },
    data: updateData,
  })

  logger.info("Finding status updated", { findingId, status: resolvedStatus })
  return updated
}

export async function markFalsePositive(
  findingId: string,
  workspaceId: string,
  reason?: string,
  actorUserId?: string
): Promise<Finding> {
  return updateFindingStatus(
    findingId,
    workspaceId,
    "FALSE_POSITIVE",
    reason,
    undefined,
    actorUserId ? { kind: "FALSE_POSITIVE", actorUserId } : undefined
  )
}

export async function acceptRisk(
  findingId: string,
  workspaceId: string,
  reason?: string,
  actorUserId?: string
): Promise<Finding> {
  return updateFindingStatus(
    findingId,
    workspaceId,
    "ACCEPTED_RISK",
    reason,
    undefined,
    actorUserId ? { kind: "ACCEPTED_RISK", actorUserId } : undefined
  )
}

export async function getFindingStats(
  workspaceId: string,
  targetId?: string,
  observedInScanId?: string,
  targetIds?: string[],
  requireActiveTarget = false,
  client?: ScopedTransaction,
  allowedProfiles?: string[]
): Promise<FindingStats> {
  const db = client ?? prisma
  const where: Record<string, unknown> = findingScopeWhere({
    workspaceId,
    ...(targetId ? { targetId } : {}),
    ...(targetIds !== undefined ? { targetIds } : {}),
    ...(observedInScanId ? { observedInScanId } : {}),
    ...(allowedProfiles !== undefined ? { allowedProfiles } : {}),
    requireActiveTarget,
  })

  const groups = await db.finding.groupBy({
    by: ["severity", "status", "verified"],
    where,
    _count: { _all: true },
  })

  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let total = 0
  let verified = 0
  let unverified = 0

  for (const g of groups) {
    const count = g._count._all
    total += count
    bySeverity[g.severity] = (bySeverity[g.severity] ?? 0) + count
    byStatus[g.status] = (byStatus[g.status] ?? 0) + count
    if (g.verified) verified += count
    else unverified += count
  }

  return {
    total,
    bySeverity,
    byStatus,
    verified,
    unverified,
  }
}

export {
  getFindingHistoryPage,
  type FindingHistoryCollection,
  type FindingHistoryPage,
} from "./finding-history-service"
