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
    target?: { id: string; name: string; type: string } | null
  })[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const where: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    deletedAt: null,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.scanId ? { scanId: params.scanId } : {}),
    ...(params.severity ? { severity: params.severity } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.verified !== undefined ? { verified: params.verified } : {}),
    ...(params.category ? { category: params.category } : {}),
  }

  const findings = await prisma.finding.findMany({
    where,
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      target: { select: { id: true, name: true, type: true } },
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
      evidence: { id: string; type: string; storageUri: string | null; redactionStatus: string }[]
      verificationReceipts: {
        id: string
        status: string
        method: string
        reason: string
        createdAt: Date
      }[]
      fixProposals: { id: string; status: string; summary: string }[]
      retests: { id: string; status: string; createdAt: Date }[]
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
          storageUri: true,
          redactionStatus: true,
        },
      },
      verificationReceipts: {
        select: { id: true, status: true, method: true, reason: true, createdAt: true },
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
  status: FindingStatus
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

  const updated = await prisma.finding.update({
    where: { id: findingId },
    data: updateData,
  })

  logger.info("Finding status updated", { findingId, status: resolvedStatus })
  return updated
}

export async function markFalsePositive(findingId: string, workspaceId: string): Promise<Finding> {
  return updateFindingStatus(findingId, workspaceId, "FALSE_POSITIVE")
}

export async function acceptRisk(findingId: string, workspaceId: string): Promise<Finding> {
  return updateFindingStatus(findingId, workspaceId, "ACCEPTED_RISK")
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

  const findings = await prisma.finding.findMany({
    where,
    select: { severity: true, status: true, verified: true },
  })

  const bySeverity: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let verified = 0
  let unverified = 0

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1
    if (f.verified) verified++
    else unverified++
  }

  return {
    total: findings.length,
    bySeverity,
    byStatus,
    verified,
    unverified,
  }
}

export async function listFindingsByScan(scanId: string, workspaceId: string): Promise<Finding[]> {
  return prisma.finding.findMany({
    where: { scanId, workspaceId, deletedAt: null },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  })
}
