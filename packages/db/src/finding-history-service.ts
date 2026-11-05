import { prisma } from "./client"
import type { ScopedTransaction } from "./rls"
import { findingScopeWhere } from "./read-query-scope"
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_PREVIEW_LIMIT,
} from "./finding-history-cursor"

export type FindingHistoryCollection =
  "evidence" | "verificationReceipts" | "fixProposals" | "retests"

export interface FindingHistoryPage<T = unknown> {
  items: T[]
  nextCursor: string | null
  total: number
}

type FindingHistoryClient = ScopedTransaction | typeof prisma

async function readHistoryRows(params: {
  db: FindingHistoryClient
  findingId: string
  workspaceId: string
  collection: FindingHistoryCollection
  limit: number
  requireActiveTarget: boolean
  cursor: ReturnType<typeof decodeHistoryCursor>
}) {
  const { db, findingId, workspaceId, collection, limit, requireActiveTarget, cursor } = params
  const after = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {}
  const activeFinding = requireActiveTarget
    ? { deletedAt: null, target: { deletedAt: null } }
    : {}

  switch (collection) {
    case "evidence": {
      const where = {
        findingId,
        finding: { workspaceId, ...activeFinding },
        redactionStatus: { not: "deleted" },
        ...after,
      }
      const [rows, total] = await Promise.all([
        db.evidence.findMany({
          where,
          select: { id: true, type: true, redactionStatus: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        db.evidence.count({
          where: {
            findingId,
            finding: { workspaceId, ...activeFinding },
            redactionStatus: { not: "deleted" },
          },
        }),
      ])
      return { rows, total }
    }
    case "verificationReceipts": {
      const where = { findingId, finding: { workspaceId, ...activeFinding }, ...after }
      const [rows, total] = await Promise.all([
        db.findingVerification.findMany({
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
        db.findingVerification.count({
          where: { findingId, finding: { workspaceId, ...activeFinding } },
        }),
      ])
      return { rows, total }
    }
    case "fixProposals": {
      const where = {
        findingId,
        finding: { workspaceId, ...activeFinding },
        deletedAt: null,
        ...after,
      }
      const [rows, total] = await Promise.all([
        db.fixProposal.findMany({
          where,
          select: { id: true, status: true, summary: true, createdAt: true, diffRef: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        db.fixProposal.count({
          where: { findingId, finding: { workspaceId, ...activeFinding }, deletedAt: null },
        }),
      ])
      return {
        rows: rows.map(({ diffRef, ...proposal }) => ({
          ...proposal,
          hasStoredPatch: Boolean(diffRef),
        })),
        total,
      }
    }
    case "retests": {
      const where = { findingId, finding: { workspaceId, ...activeFinding }, ...after }
      const [rows, total] = await Promise.all([
        db.retest.findMany({
          where,
          select: { id: true, scanId: true, status: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        db.retest.count({ where: { findingId, finding: { workspaceId, ...activeFinding } } }),
      ])
      return { rows, total }
    }
  }
}

export async function getFindingHistoryPage(
  findingId: string,
  workspaceId: string,
  collection: FindingHistoryCollection,
  options: {
    cursor?: string
    limit?: number
    targetId?: string
    targetIds?: string[]
    observedInScanId?: string
    requireActiveTarget?: boolean
    allowedProfiles?: string[]
  } = {},
  client?: ScopedTransaction
): Promise<FindingHistoryPage> {
  const db = client ?? prisma
  const limit = Math.min(Math.max(options.limit ?? HISTORY_PREVIEW_LIMIT, 1), 100)
  const cursor = decodeHistoryCursor(options.cursor, findingId, collection)
  if (options.cursor && !cursor) throw new Error("Invalid finding history cursor")

  const finding = await db.finding.findFirst({
    where: {
      id: findingId,
      ...findingScopeWhere({
        workspaceId,
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
        ...(options.observedInScanId ? { observedInScanId: options.observedInScanId } : {}),
        ...(options.allowedProfiles !== undefined
          ? { allowedProfiles: options.allowedProfiles }
          : {}),
        ...(options.requireActiveTarget ? { requireActiveTarget: true } : {}),
      }),
    },
    select: { id: true },
  })
  if (!finding) throw new Error("Finding not found")

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

  const { rows, total } = await readHistoryRows({
    db,
    findingId,
    workspaceId,
    collection,
    limit,
    requireActiveTarget: options.requireActiveTarget === true,
    cursor,
  })
  return page(rows as Array<{ id: string; createdAt: Date }>, total)
}
