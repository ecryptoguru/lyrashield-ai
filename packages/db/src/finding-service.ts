import { prisma } from "./client"
import type { Finding, FindingSeverity, FindingStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export interface ListFindingsParams {
  workspaceId: string
  targetId?: string
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

export interface FindingStats {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  verified: number
  unverified: number
}

export async function listFindings(params: ListFindingsParams): Promise<{
  items: (Finding & {
    _count?: { evidence: number; fixProposals: number }
    target?: { id: string; name: string; type: string; environment: string | null } | null
  })[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const search = params.q?.trim()
  const where: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    deletedAt: null,
    ...(params.targetId ? { targetId: params.targetId } : {}),
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

  const findings = await prisma.finding.findMany({
    where,
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
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

export async function getFinding(
  findingId: string,
  workspaceId: string
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
      fixProposals: { id: string; status: string; summary: string }[]
      retests: { id: string; scanId: string; status: string; createdAt: Date }[]
    })
  | null
> {
  return prisma.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
    include: {
      evidence: {
        select: {
          id: true,
          type: true,
          redactionStatus: true,
        },
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
        orderBy: { createdAt: "desc" },
      },
      fixProposals: {
        where: { deletedAt: null },
        select: {
          id: true,
          status: true,
          summary: true,
        },
      },
      retests: {
        select: {
          id: true,
          scanId: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  })
}

export async function updateFindingStatus(
  findingId: string,
  workspaceId: string,
  status: FindingStatus,
  reason?: string
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
  reason?: string
): Promise<Finding> {
  return updateFindingStatus(findingId, workspaceId, "FALSE_POSITIVE", reason)
}

export async function acceptRisk(
  findingId: string,
  workspaceId: string,
  reason?: string
): Promise<Finding> {
  return updateFindingStatus(findingId, workspaceId, "ACCEPTED_RISK", reason)
}

export async function getFindingStats(
  workspaceId: string,
  targetId?: string
): Promise<FindingStats> {
  const where: Record<string, unknown> = {
    workspaceId,
    deletedAt: null,
    ...(targetId ? { targetId } : {}),
  }

  const groups = await prisma.finding.groupBy({
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

export type FindingForScore = Pick<
  Finding,
  "id" | "severity" | "status" | "verified" | "verificationStatus" | "category"
>

export async function listFindingsByScan(
  scanId: string,
  workspaceId: string
): Promise<FindingForScore[]> {
  return prisma.finding.findMany({
    where: { scanId, workspaceId, deletedAt: null },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      severity: true,
      status: true,
      verified: true,
      verificationStatus: true,
      category: true,
    },
  })
}
