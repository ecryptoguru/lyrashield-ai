import { createHash } from "crypto"
import { prisma, createScan, listScans, updateScanStatus, type ScanListItem } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateScanSchema, ScanStatusSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { revalidateDashboardAggregates } from "../../../lib/cache"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, parsePaginationParams } from "../../../lib/api-response"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"

/**
 * Serialize a scan list row for the client. Dates become ISO strings so the
 * polled payload matches the SSR-rendered shape exactly (the client's ScanItem
 * type expects strings, and `findingCount` is already flattened by listScans).
 */
function serializeScanListItem(scan: ScanListItem) {
  return {
    ...scan,
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    createdAt: scan.createdAt.toISOString(),
  }
}

/**
 * ETag over the entire response representation. The active-scan poll re-requests
 * this list on an interval; when nothing has moved the client gets a 304 with no
 * body to parse.
 *
 * Hashing the full payload (not a subset of fields) is deliberate: a summary,
 * error message, or target rename can change while status and counts stay put,
 * and a partial hash would then serve a 304 and freeze stale data on screen.
 */
function scanListEtag(
  items: ReturnType<typeof serializeScanListItem>[],
  nextCursor: string | null
): string {
  const payload = JSON.stringify({ items, nextCursor })
  return `"${createHash("sha256").update(payload).digest("hex")}"`
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = CreateScanSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const data = parsed.data
  const workspaceId = data.workspaceId

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)

    const target = await prisma.target.findFirst({
      where: { id: data.targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    const policy = await prisma.policy.findFirst({
      where: data.policyId
        ? { id: data.policyId, workspaceId, deletedAt: null }
        : { workspaceId, name: "Default Policy", deletedAt: null },
      orderBy: data.policyId ? undefined : { createdAt: "asc" },
      select: { id: true },
    })
    if (data.policyId && !policy) {
      return apiError("POLICY_NOT_FOUND", "Policy not found in this workspace", 404)
    }
    const policyId = policy?.id

    const activeScans = await prisma.scan.count({
      where: {
        workspaceId,
        targetId: data.targetId,
        status: { in: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"] },
      },
    })
    if (activeScans > 0) {
      return apiError(
        "SCAN_IN_PROGRESS",
        "Target already has an active scan. Cancel it or wait for completion.",
        409
      )
    }

    try {
      await assertScanWorkerAvailable()
    } catch (error) {
      if (error instanceof ScanWorkerUnavailableError) {
        return apiError(
          "SCAN_SERVICE_UNAVAILABLE",
          "Scanning is temporarily unavailable. Please try again shortly.",
          503
        )
      }
      throw error
    }

    const scan = await createScan({
      workspaceId,
      targetId: data.targetId,
      goal: data.goal,
      mode: data.mode,
      policyId,
      createdById: session.userId,
    })

    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId,
        targetId: data.targetId,
        goal: data.goal,
        mode: data.mode,
        policyId,
      })
    } catch (enqueueErr) {
      logger.error("Failed to enqueue scan job", {
        scanId: scan.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      })
      await updateScanStatus(scan.id, "FAILED", {
        errorCategory: "QUEUE",
        errorMessage: "Scan worker became unavailable while queueing the scan",
      })
      revalidateDashboardAggregates()
      return apiError(
        "SCAN_SERVICE_UNAVAILABLE",
        "Scanning became unavailable while starting this scan. Please try again shortly.",
        503
      )
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "scan.created",
        resourceType: "scan",
        resourceId: scan.id,
      },
    })

    logger.info("Scan created and enqueued", {
      scanId: scan.id,
      workspaceId,
      targetId: data.targetId,
    })

    revalidateDashboardAggregates()

    return apiSuccess(
      {
        id: scan.id,
        status: scan.status,
        goal: scan.goal,
        mode: scan.mode,
        targetId: scan.targetId,
        createdAt: scan.createdAt,
      },
      201
    )
  } catch (error) {
    if (
      (error && typeof error === "object" && (error as { code?: string }).code === "P2002") ||
      (error instanceof Error && error.message === "Target already has an active scan")
    ) {
      return apiError(
        "SCAN_IN_PROGRESS",
        "Target already has an active scan. Cancel it or wait for completion.",
        409
      )
    }
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create scan", 500)
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const rawStatus = searchParams.get("status")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    // Support a single status value or a comma-separated list of statuses.
    let statusFilter: Parameters<typeof listScans>[0]["statuses"] | undefined
    let singleStatus: Parameters<typeof listScans>[0]["status"] | undefined
    if (rawStatus) {
      const parts = rawStatus
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length > 1) {
        const parsed = parts.map((s) => ScanStatusSchema.safeParse(s))
        const invalid = parsed.find((r) => !r.success)
        if (invalid) {
          return apiError("INVALID_PARAM", "status contains an invalid scan status value", 400)
        }
        statusFilter = parsed.map((r) => (r as { success: true; data: typeof singleStatus }).data!)
      } else {
        const parsed = ScanStatusSchema.safeParse(parts[0])
        if (!parsed.success) {
          return apiError("INVALID_PARAM", "status must be a valid scan status", 400)
        }
        singleStatus = parsed.data
      }
    }

    await requirePermission(workspaceId, PERMISSIONS.scan.view)

    const { cursor, limit } = parsePaginationParams(searchParams)

    const { items, nextCursor } = await listScans({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(statusFilter ? { statuses: statusFilter } : singleStatus ? { status: singleStatus } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    const serialized = items.map(serializeScanListItem)
    const etag = scanListEtag(serialized, nextCursor)
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    return NextResponse.json(
      { success: true, data: { items: serialized, nextCursor } },
      { status: 200, headers: { ETag: etag } }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list scans", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list scans", 500)
  }
}
