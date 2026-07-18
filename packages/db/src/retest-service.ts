import { prisma } from "./client"
import type { Retest, Finding, Scan } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export interface RetestWithDetails extends Retest {
  finding: Pick<Finding, "id" | "title" | "severity" | "status">
  scan: Pick<Scan, "id" | "status" | "summary">
}

const VALID_RETEST_STATUSES = ["pending", "running", "passed", "failed", "error"] as const

export async function createRetest(params: {
  workspaceId: string
  findingId: string
  scanId: string
}): Promise<Retest> {
  const retest = await prisma.retest.create({
    data: {
      workspaceId: params.workspaceId,
      findingId: params.findingId,
      scanId: params.scanId,
      status: "pending",
    },
  })

  logger.info("Retest created", {
    findingId: params.findingId,
    retestId: retest.id,
  })

  return retest
}

export async function getRetest(
  retestId: string,
  workspaceId: string
): Promise<RetestWithDetails | null> {
  const retest = await prisma.retest.findFirst({
    where: {
      id: retestId,
      workspaceId,
    },
    include: {
      finding: {
        select: { id: true, title: true, severity: true, status: true },
      },
      scan: {
        select: { id: true, status: true, summary: true },
      },
    },
  })

  return retest as RetestWithDetails | null
}

export async function listRetests(params: {
  workspaceId: string
  findingId?: string
  status?: string
  cursor?: string
  limit?: number
}): Promise<{ items: RetestWithDetails[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  const retests = await prisma.retest.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.findingId ? { findingId: params.findingId } : {}),
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      finding: {
        select: { id: true, title: true, severity: true, status: true },
      },
      scan: {
        select: { id: true, status: true, summary: true },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const hasMore = retests.length > limit
  const items = (hasMore ? retests.slice(0, limit) : retests) as RetestWithDetails[]
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}

export async function updateRetestStatus(
  retestId: string,
  workspaceId: string,
  status: string,
  resultAfter?: string
): Promise<Retest> {
  if (!VALID_RETEST_STATUSES.includes(status as (typeof VALID_RETEST_STATUSES)[number])) {
    throw new Error(`Invalid retest status: ${status}`)
  }

  const retest = await prisma.retest.findFirst({
    where: { id: retestId, workspaceId },
  })

  if (!retest) {
    throw new Error(`Retest not found: ${retestId}`)
  }

  return prisma.retest.update({
    where: { id: retestId },
    data: {
      status,
      ...(resultAfter ? { resultAfter } : {}),
    },
  })
}
