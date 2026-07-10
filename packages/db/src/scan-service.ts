import { prisma } from "./client"
import type { Scan, ScanEvent, ScanStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { isValidTransition } from "./scan-transitions"

export interface CreateScanParams {
  workspaceId: string
  targetId: string
  goal: string
  mode?: string
  policyId?: string
  createdById: string
  triggerType?: string
}

export interface ScanWithEvents extends Scan {
  events: ScanEvent[]
}

const ACTIVE_SCAN_STATUSES: ScanStatus[] = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"]

export async function createScan(params: CreateScanParams): Promise<Scan> {
  const scan = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.targetId}))`

    const activeScans = await tx.scan.count({
      where: {
        targetId: params.targetId,
        status: { in: ACTIVE_SCAN_STATUSES },
        deletedAt: null,
      },
    })
    if (activeScans > 0) {
      throw new Error("Target already has an active scan")
    }

    return tx.scan.create({
      data: {
        workspaceId: params.workspaceId,
        targetId: params.targetId,
        goal: params.goal as Scan["goal"],
        mode: (params.mode ?? "SAFE") as Scan["mode"],
        policyId: params.policyId ?? null,
        status: "QUEUED",
        triggerType: params.triggerType ?? "manual",
        createdById: params.createdById,
      },
    })
  })

  await addScanEvent(scan.id, "queued", "info", "Scan queued", {
    targetId: params.targetId,
    goal: params.goal,
    mode: params.mode ?? "SAFE",
  })

  logger.info("Scan created", { scanId: scan.id, workspaceId: params.workspaceId, targetId: params.targetId })
  return scan
}

export async function updateScanStatus(
  scanId: string,
  newStatus: ScanStatus,
  metadata?: {
    errorCategory?: string
    errorMessage?: string
    summary?: string
    riskScoreAfter?: number
    actualCostCents?: number
  }
): Promise<Scan> {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } })
  if (!scan) throw new Error(`Scan not found: ${scanId}`)

  const currentStatus = scan.status as ScanStatus
  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(`Invalid scan status transition: ${currentStatus} → ${newStatus}`)
  }

  const now = new Date()
  const updateData: Record<string, unknown> = {
    status: newStatus,
    ...(metadata?.errorCategory ? { errorCategory: metadata.errorCategory } : {}),
    ...(metadata?.errorMessage ? { errorMessage: metadata.errorMessage } : {}),
    ...(metadata?.summary ? { summary: metadata.summary } : {}),
    ...(metadata?.riskScoreAfter !== undefined ? { riskScoreAfter: metadata.riskScoreAfter } : {}),
    ...(metadata?.actualCostCents !== undefined ? { actualCostCents: metadata.actualCostCents } : {}),
  }

  if (newStatus === "PREFLIGHT" || newStatus === "RUNNING") {
    if (!scan.startedAt) updateData.startedAt = now
  }
  if (
    newStatus === "COMPLETED" ||
    newStatus === "FAILED" ||
    newStatus === "CANCELLED" ||
    newStatus === "STOPPED_BUDGET" ||
    newStatus === "TIMED_OUT"
  ) {
    updateData.endedAt = now
  }

  const result = await prisma.scan.updateMany({
    where: { id: scanId, status: currentStatus },
    data: updateData,
  })
  if (result.count !== 1) {
    const latest = await prisma.scan.findUnique({ where: { id: scanId } })
    throw new Error(`Scan status changed concurrently to ${latest?.status ?? "unknown"}`)
  }

  const updated = await prisma.scan.findUnique({ where: { id: scanId } })
  if (!updated) throw new Error(`Scan not found after status update: ${scanId}`)

  await addScanEvent(scanId, newStatus.toLowerCase(), "info", `Scan status: ${newStatus}`, metadata ?? {})

  logger.info("Scan status updated", { scanId, from: currentStatus, to: newStatus })
  return updated
}

export async function addScanEvent(
  scanId: string,
  stage: string,
  level: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<ScanEvent> {
  return prisma.scanEvent.create({
    data: {
      scanId,
      stage,
      level,
      message,
      metadata: metadata ?? undefined,
    },
  })
}

export async function getScanWithEvents(scanId: string): Promise<ScanWithEvents | null> {
  return prisma.scan.findUnique({
    where: { id: scanId },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        take: 200,
      },
    },
  })
}

export interface ListScansParams {
  workspaceId: string
  targetId?: string
  status?: ScanStatus
  cursor?: string
  limit?: number
}

export async function listScans(params: ListScansParams): Promise<{
  items: Scan[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const where: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    deletedAt: null,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.status ? { status: params.status } : {}),
  }

  const scans = await prisma.scan.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      target: { select: { id: true, name: true, type: true, url: true, repoFullName: true } },
      _count: { select: { findings: { where: { deletedAt: null } } } },
    },
  })

  const hasMore = scans.length > limit
  const items = hasMore ? scans.slice(0, limit) : scans
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}

export async function cancelScan(scanId: string): Promise<Scan> {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } })
  if (!scan) throw new Error(`Scan not found: ${scanId}`)

  const status = scan.status as ScanStatus
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" || status === "STOPPED_BUDGET" || status === "TIMED_OUT") {
    throw new Error(`Cannot cancel scan in terminal state: ${status}`)
  }

  return updateScanStatus(scanId, "CANCELLED")
}
