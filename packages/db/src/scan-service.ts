import { prisma } from "./client"
import type {
  Scan,
  ScanEvent,
  ScanStatus,
  ScanResultManifest,
  ScanCoverageReceipt,
  AiSecurityScoreSnapshot,
} from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { DeterminismModeSchema, ScanIdSchema, type DeterminismMode } from "@lyrashield/types"
import { isTerminalScanStatus, isValidTransition } from "./scan-transitions"
import { withWorkspaceRLS } from "./rls"
import { getWorkspaceContext } from "./extension"

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
  /**
   * Checksum only. The manifest's `manifest` Json column can reach tens of KB,
   * and this shape is returned on every scan-detail poll, so fetching the whole
   * row would pull that blob out of Postgres every few seconds for a field no
   * consumer reads — every caller uses `checksum` alone.
   */
  resultManifest: Pick<ScanResultManifest, "checksum"> | null
  coverageReceipts: ScanCoverageReceipt[]
  aiSecurityScoreSnapshot: AiSecurityScoreSnapshot | null
  target: {
    id: string
    name: string
    type: string
    url: string | null
    repoFullName: string | null
  } | null
}

const ACTIVE_SCAN_STATUSES: ScanStatus[] = [
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
]
type ScanTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type ScanStatusMetadata = {
  errorCategory?: string
  errorMessage?: string
  summary?: string
  riskScoreAfter?: number
  actualCostCents?: number
}

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
        mode: (params.mode ?? "QUICK") as Scan["mode"],
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
          mode: params.mode ?? "QUICK",
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

async function updateScanStatusInTransaction(
  tx: ScanTransaction,
  scanId: string,
  newStatus: ScanStatus,
  metadata?: ScanStatusMetadata,
  guard?: { finalizationStartedAt: null }
) {
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
    ...(metadata?.riskScoreAfter !== undefined ? { riskScoreAfter: metadata.riskScoreAfter } : {}),
    ...(metadata?.actualCostCents !== undefined
      ? { actualCostCents: metadata.actualCostCents }
      : {}),
  }

  if ((newStatus === "PREFLIGHT" || newStatus === "RUNNING") && !scan.startedAt) {
    updateData.startedAt = now
  }
  if (isTerminalScanStatus(newStatus)) {
    updateData.endedAt = now
    const startTime = (updateData.startedAt as Date | undefined) ?? scan.startedAt
    if (startTime) {
      const durationMs = now.getTime() - new Date(startTime).getTime()
      updateData.durationMs = Math.max(0, Math.round(durationMs))
    }
  }

  const result = await tx.scan.updateMany({
    where: { id: scanId, status: currentStatus, ...guard },
    data: updateData,
  })
  if (result.count !== 1) {
    const latest = await tx.scan.findUnique({ where: { id: scanId } })
    if (guard && latest?.finalizationStartedAt) {
      throw new Error("Scan finalization already started")
    }
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

export async function updateScanStatus(
  scanId: string,
  newStatus: ScanStatus,
  metadata?: ScanStatusMetadata,
  workspaceId?: string
): Promise<Scan> {
  const resolvedWorkspaceId = workspaceId ?? getWorkspaceContext()
  if (!resolvedWorkspaceId) {
    throw new Error(`workspaceId or workspace context is required for updateScanStatus`)
  }

  const { updated, currentStatus } = await withWorkspaceRLS(resolvedWorkspaceId, (tx) =>
    updateScanStatusInTransaction(tx, scanId, newStatus, metadata)
  )

  logger.info("Scan status updated", { scanId, from: currentStatus, to: newStatus })
  return updated
}

export async function withScanFinalizationClaim<T>(
  scanId: string,
  workspaceId: string,
  finalize: () => Promise<T>
): Promise<{ status: "cancelled" } | { status: "finalized"; value: T }> {
  const claimed = await withWorkspaceRLS(workspaceId, async (tx) => {
    const result = await tx.scan.updateMany({
      where: { id: scanId, workspaceId, status: "VERIFYING", finalizationStartedAt: null },
      data: { finalizationStartedAt: new Date() },
    })
    if (result.count === 1) return true

    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      select: { status: true, finalizationStartedAt: true },
    })
    if (!scan) throw new Error(`Scan not found: ${scanId}`)
    if (scan.status === "CANCELLED") return false
    if (scan.finalizationStartedAt) throw new Error("Scan finalization already started")
    throw new Error(`Cannot finalize scan from ${scan.status}`)
  })
  return claimed ? { status: "finalized", value: await finalize() } : { status: "cancelled" }
}

export async function addScanEvent(
  scanId: string,
  stage: string,
  level: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<ScanEvent> {
  const workspaceId = getWorkspaceContext()
  if (!workspaceId) {
    throw new Error("workspace context is required for addScanEvent")
  }

  return withWorkspaceRLS(workspaceId, async (tx) => {
    // Defense-in-depth: verify the scan belongs to the current workspace before
    // writing an event. ScanEvent is a child table without its own workspaceId, so
    // this prevents cross-tenant event injection if a caller has a valid scanId
    // from another workspace. The RLS context enforces this, but the explicit
    // comparison keeps the guard visible and unit-testable without a live DB.
    const scan = await tx.scan.findUnique({
      where: { id: scanId },
      select: { workspaceId: true },
    })
    if (!scan || scan.workspaceId !== workspaceId) {
      throw new Error(`Scan not found in workspace: ${scanId}`)
    }

    return tx.scanEvent.create({
      data: {
        scanId,
        stage,
        level,
        message,
        metadata: metadata ?? undefined,
      },
    })
  })
}

export async function getScanWithEvents(
  scanId: string,
  workspaceId: string
): Promise<ScanWithEvents | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      include: {
        events: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 200,
        },
        // Checksum only, matching the documented ScanWithEvents contract: the
        // manifest blob can reach tens of KB and this shape is returned on
        // every scan-detail poll. One-time consumers that need manifest fields
        // use getScanResultManifestDetail instead.
        resultManifest: { select: { checksum: true } },
        coverageReceipts: {
          orderBy: { controlId: "asc" },
        },
        aiSecurityScoreSnapshot: true,
        target: {
          select: { id: true, name: true, type: true, url: true, repoFullName: true },
        },
      },
    })
    if (!scan) return null

    return {
      ...scan,
      events: scan.events.reverse(),
      resultManifest: scan.resultManifest,
      coverageReceipts: scan.coverageReceipts,
      target: scan.target,
    }
  })
}

/**
 * One-time manifest detail for the server-rendered scan page: checksum plus the
 * urlExecution slice extracted from the manifest JSON. Kept separate from
 * getScanWithEvents so the polling path never fetches the tens-of-KB blob.
 */
export async function getScanResultManifestDetail(
  scanId: string,
  workspaceId: string
): Promise<{ checksum: string; urlExecution: Record<string, unknown> | null } | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const manifest = await tx.scanResultManifest.findUnique({
      where: { scanId },
      select: { checksum: true, manifest: true },
    })
    if (!manifest) return null
    const urlExecution = (manifest.manifest as { urlExecution?: unknown } | null)?.urlExecution
    return {
      checksum: manifest.checksum,
      urlExecution:
        urlExecution && typeof urlExecution === "object" && !Array.isArray(urlExecution)
          ? (urlExecution as Record<string, unknown>)
          : null,
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
  statuses?: ScanStatus[]
  cursor?: string
  limit?: number
}

/**
 * List-view projection for a scan row.
 *
 * Deliberately narrow: the Scan model carries ~10 further columns (LLM token
 * counters, provider/billed cost, risk scores, sarifUri, policyId) that no list
 * surface renders. This list is fetched on every scans-page load and on every
 * active-scan poll tick, so those columns would be read and serialized
 * continuously for nothing.
 */
export const SCAN_LIST_SELECT = {
  id: true,
  status: true,
  goal: true,
  mode: true,
  triggerType: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  summary: true,
  errorCategory: true,
  errorMessage: true,
  createdAt: true,
  target: {
    select: { id: true, name: true, type: true, url: true, apiSpecUrl: true, repoFullName: true },
  },
  _count: { select: { findings: { where: { deletedAt: null } } } },
} as const

export interface ScanListItem {
  id: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: Date | null
  endedAt: Date | null
  durationMs: number | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  createdAt: Date
  findingCount: number
  target: {
    id: string
    name: string
    type: string
    url: string | null
    apiSpecUrl: string | null
    repoFullName: string | null
  } | null
}

/** Flatten Prisma's `_count` into the `findingCount` the list surfaces render. */
export function toScanListItem(
  scan: Omit<ScanListItem, "findingCount"> & { _count?: { findings: number } | null }
): ScanListItem {
  const { _count, ...rest } = scan
  return { ...rest, findingCount: _count?.findings ?? 0 }
}

export async function listScans(params: ListScansParams): Promise<{
  items: ScanListItem[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const statusFilter =
    params.statuses && params.statuses.length > 0
      ? { status: { in: params.statuses } }
      : params.status
        ? { status: params.status }
        : {}
  const where: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    deletedAt: null,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...statusFilter,
  }

  // Run inside withWorkspaceRLS so `SET LOCAL app.current_workspace_id` and the
  // query share one connection. The workspaceId predicate above is not a
  // substitute: "Scan" is under FORCE ROW LEVEL SECURITY, so the database policy
  // is the actual isolation boundary and it needs the transaction-local context.
  const scans = await withWorkspaceRLS(params.workspaceId, (tx) =>
    tx.scan.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      select: SCAN_LIST_SELECT,
    })
  )

  const hasMore = scans.length > limit
  const page = hasMore ? scans.slice(0, limit) : scans
  const items = page.map(toScanListItem)
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}

export async function cancelScan(scanId: string, workspaceId: string): Promise<Scan> {
  const { updated, currentStatus } = await withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
    })
    if (!scan) throw new Error(`Scan not found: ${scanId}`)

    const status = scan.status as ScanStatus
    if (isTerminalScanStatus(status)) {
      throw new Error(`Cannot cancel scan in terminal state: ${status}`)
    }

    return updateScanStatusInTransaction(tx, scanId, "CANCELLED", undefined, {
      finalizationStartedAt: null,
    })
  })
  logger.info("Scan status updated", { scanId, from: currentStatus, to: "CANCELLED" })
  return updated
}

export async function removeScan(scanId: string, workspaceId: string): Promise<Pick<Scan, "id">> {
  const validatedScanId = ScanIdSchema.parse(scanId)

  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: validatedScanId, workspaceId, deletedAt: null },
      select: { id: true, status: true },
    })
    if (!scan) throw new Error(`Scan not found: ${validatedScanId}`)
    if (!isTerminalScanStatus(scan.status)) throw new Error("Cannot remove an active scan")

    return tx.scan.update({
      where: { id: scan.id },
      data: { deletedAt: new Date() },
      select: { id: true },
    })
  })
}
