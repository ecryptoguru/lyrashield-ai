import { prisma } from "./client"
import type { Finding, FindingSeverity, FindingStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

const HISTORY_PREVIEW_LIMIT = 25

export type FindingHistoryCollection =
  "evidence" | "verificationReceipts" | "fixProposals" | "retests"

export interface FindingHistoryPage<T = unknown> {
  items: T[]
  nextCursor: string | null
  total: number
}

interface HistoryCursor {
  findingId: string
  collection: FindingHistoryCollection
  createdAt: string
  id: string
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function decodeHistoryCursor(
  value: string | undefined,
  findingId: string,
  collection: FindingHistoryCollection
): HistoryCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as HistoryCursor
    if (
      parsed.findingId !== findingId ||
      parsed.collection !== collection ||
      typeof parsed.id !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

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

type FindingDispositionInput = {
  kind: "ACCEPTED_RISK" | "FALSE_POSITIVE"
  actorUserId: string
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
      historyPagination: Record<
        FindingHistoryCollection,
        { total: number; nextCursor: string | null }
      >
    })
  | null
> {
  const finding = await prisma.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
    include: {
      evidence: {
        where: { redactionStatus: { not: "deleted" } },
        select: {
          id: true,
          type: true,
          redactionStatus: true,
          createdAt: true,
        },
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
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_PREVIEW_LIMIT + 1,
      },
      retests: {
        select: {
          id: true,
          scanId: true,
          status: true,
          createdAt: true,
        },
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
    },
  })
  if (!finding) return null

  const buildPreview = <T extends { id: string; createdAt?: Date }>(
    collection: FindingHistoryCollection,
    rows: T[],
    total: number
  ) => {
    const items = rows.slice(0, HISTORY_PREVIEW_LIMIT)
    const last = items.at(-1)
    const nextCursor =
      rows.length > HISTORY_PREVIEW_LIMIT && last?.createdAt
        ? encodeHistoryCursor({
            findingId,
            collection,
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null
    return { items, pagination: { total, nextCursor } }
  }

  const evidence = buildPreview("evidence", finding.evidence, finding._count.evidence)
  const verificationReceipts = buildPreview(
    "verificationReceipts",
    finding.verificationReceipts,
    finding._count.verificationReceipts
  )
  const fixProposals = buildPreview(
    "fixProposals",
    finding.fixProposals,
    finding._count.fixProposals
  )
  const retests = buildPreview("retests", finding.retests, finding._count.retests)

  const { _count, ...baseFinding } = finding
  void _count
  return {
    ...baseFinding,
    evidence: evidence.items,
    verificationReceipts: verificationReceipts.items,
    fixProposals: fixProposals.items,
    retests: retests.items,
    historyPagination: {
      evidence: evidence.pagination,
      verificationReceipts: verificationReceipts.pagination,
      fixProposals: fixProposals.pagination,
      retests: retests.pagination,
    },
  }
}

export async function getFindingReference(findingId: string, workspaceId: string) {
  return prisma.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
    select: { id: true, scanId: true, targetId: true },
  })
}

export async function getFindingHistoryPage(
  findingId: string,
  workspaceId: string,
  collection: FindingHistoryCollection,
  options: { cursor?: string; limit?: number } = {}
): Promise<FindingHistoryPage> {
  const limit = Math.min(Math.max(options.limit ?? HISTORY_PREVIEW_LIMIT, 1), 100)
  const cursor = decodeHistoryCursor(options.cursor, findingId, collection)
  if (options.cursor && !cursor) throw new Error("Invalid finding history cursor")

  const finding = await prisma.finding.findFirst({
    where: { id: findingId, workspaceId, deletedAt: null },
    select: { id: true },
  })
  if (!finding) throw new Error("Finding not found")

  const after = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {}
  const page = <T extends { id: string; createdAt: Date }>(rows: T[], total: number) => {
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      total,
      nextCursor:
        rows.length > limit && last
          ? encodeHistoryCursor({
              findingId,
              collection,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    }
  }

  switch (collection) {
    case "evidence": {
      const where = { findingId, redactionStatus: { not: "deleted" }, ...after }
      const [rows, total] = await Promise.all([
        prisma.evidence.findMany({
          where,
          select: { id: true, type: true, redactionStatus: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        prisma.evidence.count({ where: { findingId, redactionStatus: { not: "deleted" } } }),
      ])
      return page(rows, total)
    }
    case "verificationReceipts": {
      const where = { findingId, workspaceId, ...after }
      const [rows, total] = await Promise.all([
        prisma.findingVerification.findMany({
          where,
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
          take: limit + 1,
        }),
        prisma.findingVerification.count({ where: { findingId, workspaceId } }),
      ])
      return page(rows, total)
    }
    case "fixProposals": {
      const where = { findingId, deletedAt: null, ...after }
      const [rows, total] = await Promise.all([
        prisma.fixProposal.findMany({
          where,
          select: { id: true, status: true, summary: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        prisma.fixProposal.count({ where: { findingId, deletedAt: null } }),
      ])
      return page(rows, total)
    }
    case "retests": {
      const where = { findingId, workspaceId, ...after }
      const [rows, total] = await Promise.all([
        prisma.retest.findMany({
          where,
          select: { id: true, scanId: true, status: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        prisma.retest.count({ where: { findingId, workspaceId } }),
      ])
      return page(rows, total)
    }
  }
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
