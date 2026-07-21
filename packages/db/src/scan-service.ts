import { prisma } from "./client"
import type {
  Scan,
  ScanEvent,
  ScanStatus,
  ScanResultManifest,
  ScanCoverageReceipt,
} from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { DeterminismModeSchema, type DeterminismMode } from "@lyrashield/types"
import { isValidTransition } from "./scan-transitions"
import { withWorkspaceRLS } from "./rls"

export interface CreateScanParams {
  workspaceId: string
  targetId: string
  goal: string
  mode?: string
  policyId?: string
  createdById: string
  triggerType?: string
  determinismMode?: DeterminismMode
}

export interface ScanWithEvents extends Scan {
  events: ScanEvent[]
  resultManifest: ScanResultManifest | null
  coverageReceipts: ScanCoverageReceipt[]
}

const ACTIVE_SCAN_STATUSES: ScanStatus[] = [
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
]

export async function createScan(params: CreateScanParams): Promise<Scan> {
  const determinismMode = DeterminismModeSchema.parse(params.determinismMode ?? "default")
  const scan = await withWorkspaceRLS(params.workspaceId, async (tx) => {
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

    const scan = await tx.scan.create({
      data: {
        workspaceId: params.workspaceId,
        targetId: params.targetId,
        goal: params.goal as Scan["goal"],
        mode: (params.mode ?? "SAFE") as Scan["mode"],
        policyId: params.policyId ?? null,
        status: "QUEUED",
        triggerType: params.triggerType ?? "manual",
        determinismMode,
        createdById: params.createdById,
      },
    })
    await tx.scanEvent.create({
      data: {
        scanId: scan.id,
        stage: "queued",
        level: "info",
        message: "Scan queued",
        metadata: {
          targetId: params.targetId,
          goal: params.goal,
          mode: params.mode ?? "SAFE",
        },
      },
    })
    return scan
  })

  logger.info("Scan created", {
    scanId: scan.id,
    workspaceId: params.workspaceId,
    targetId: params.targetId,
  })
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
  },
  workspaceId?: string
): Promise<Scan> {
  const updateInTransaction = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
  ) => {
    const scan = await tx.scan.findUnique({ where: { id: scanId } })
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
      ...(metadata?.riskScoreAfter !== undefined
        ? { riskScoreAfter: metadata.riskScoreAfter }
        : {}),
      ...(metadata?.actualCostCents !== undefined
        ? { actualCostCents: metadata.actualCostCents }
        : {}),
    }

    if ((newStatus === "PREFLIGHT" || newStatus === "RUNNING") && !scan.startedAt) {
      updateData.startedAt = now
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(newStatus)) {
      updateData.endedAt = now
    }

    const result = await tx.scan.updateMany({
      where: { id: scanId, status: currentStatus },
      data: updateData,
    })
    if (result.count !== 1) {
      const latest = await tx.scan.findUnique({ where: { id: scanId } })
      throw new Error(`Scan status changed concurrently to ${latest?.status ?? "unknown"}`)
    }

    const updated = await tx.scan.findUnique({ where: { id: scanId } })
    if (!updated) throw new Error(`Scan not found after status update: ${scanId}`)
    await tx.scanEvent.create({
      data: {
        scanId,
        stage: newStatus.toLowerCase(),
        level: "info",
        message: `Scan status: ${newStatus}`,
        metadata: metadata ?? undefined,
      },
    })
    return { updated, currentStatus }
  }
  const { updated, currentStatus } = workspaceId
    ? await withWorkspaceRLS(workspaceId, updateInTransaction)
    : await prisma.$transaction(updateInTransaction)

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

export async function getScanWithEvents(
  scanId: string,
  workspaceId: string
): Promise<ScanWithEvents | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
    })
    if (!scan) return null

    // Keep relation reads sequential on the transaction connection. Prisma's
    // relation include planner can issue concurrent pg queries; pg 8 warns and
    // pg 9 will reject that usage on a single interactive transaction client.
    const events = await tx.scanEvent.findMany({
      where: { scanId, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    })
    const resultManifest = await tx.scanResultManifest.findUnique({ where: { scanId } })
    const coverageReceipts = await tx.scanCoverageReceipt.findMany({
      where: { scanId },
      orderBy: { controlId: "asc" },
    })

    return {
      ...scan,
      events: events.reverse(),
      resultManifest,
      coverageReceipts,
    }
  })
}

/**
 * Fetch a scan by id, explicitly scoped to a workspace. Use this whenever a
 * caller-supplied scanId must be proven to belong to the caller's workspace
 * before it is trusted (e.g. attaching a scan to a report) — do NOT rely on the
 * Prisma extension's implicit read-scoping for a security boundary.
 */
export async function getScanForWorkspace(
  scanId: string,
  workspaceId: string
): Promise<Scan | null> {
  return prisma.scan.findFirst({
    where: { id: scanId, workspaceId, deletedAt: null },
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

export async function cancelScan(scanId: string, workspaceId: string): Promise<Scan> {
  const scan = await prisma.scan.findFirst({
    where: { id: scanId, workspaceId, deletedAt: null },
  })
  if (!scan) throw new Error(`Scan not found: ${scanId}`)

  const status = scan.status as ScanStatus
  if (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "STOPPED_BUDGET" ||
    status === "TIMED_OUT"
  ) {
    throw new Error(`Cannot cancel scan in terminal state: ${status}`)
  }

  return updateScanStatus(scanId, "CANCELLED", undefined, workspaceId)
}
