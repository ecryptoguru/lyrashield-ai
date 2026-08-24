import { createHash } from "crypto"
import { getScanWithEvents, cancelScan, prisma, removeScan } from "@lyrashield/db"
import { getScanQueuePosition } from "@lyrashield/integrations"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { NextResponse } from "next/server"
import { z } from "zod"
import { ScanIdSchema } from "@lyrashield/types"
import { revalidateDashboardAggregates } from "../../../../lib/cache"

function scanEtag(scan: NonNullable<Awaited<ReturnType<typeof getScanWithEvents>>>): string {
  const events = scan.events ?? []
  const lastEvent = events[events.length - 1]
  const payload = JSON.stringify({
    id: scan.id,
    status: scan.status,
    updatedAt: scan.updatedAt,
    eventsCount: events.length,
    lastEventAt: lastEvent?.createdAt,
  })
  return `"${createHash("sha256").update(payload).digest("hex")}"`
}

const WorkspaceSchema = z.string().min(1)

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsedWorkspace = WorkspaceSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )

  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspace.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const scan = await getScanWithEvents(id, workspaceId)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    const etag = scanEtag(scan)
    const ifNoneMatch = request.headers.get("if-none-match")
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    // Surface the scan's place in the run queue so the dashboard can tell the
    // user how far from the front they are. Only meaningful while QUEUED; the
    // helper returns null for a scan that is already running or done.
    const queuePosition = scan.status === "QUEUED" ? await getScanQueuePosition(id) : null

    return NextResponse.json(
      { success: true, data: { ...scan, queuePosition } },
      { status: 200, headers: { ETag: etag } }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get scan", 500)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }
  const parsed = z.object({ workspaceId: WorkspaceSchema }).safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }
  const { workspaceId } = parsed.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.scan.cancel)
    const scan = await getScanWithEvents(id, workspaceId)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    const cancelled = await cancelScan(id, workspaceId)
    revalidateDashboardAggregates()
    return apiSuccess({
      id: cancelled.id,
      status: cancelled.status,
      endedAt: cancelled.endedAt,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message.includes("terminal state")) {
      return apiError("SCAN_ALREADY_FINISHED", error.message, 409)
    }
    if (error instanceof Error && error.message.includes("finalization already started")) {
      return apiError("SCAN_FINALIZATION_STARTED", "Scan finalization already started", 409)
    }
    logger.error("Failed to cancel scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to cancel scan", 500)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params
  const parsedId = ScanIdSchema.safeParse(rawId)
  if (!parsedId.success) {
    return apiError("VALIDATION_ERROR", "scan id is required", 400)
  }
  const id = parsedId.data
  const parsedWorkspace = WorkspaceSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )
  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspace.data

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.cancel)
    await removeScan(id, workspaceId)
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "scan.removed",
        resourceType: "scan",
        resourceId: id,
      },
    })
    revalidateDashboardAggregates()
    return apiSuccess({ id, removed: true })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message.includes("not found")) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }
    if (error instanceof Error && error.message.includes("active scan")) {
      return apiError("SCAN_ACTIVE", "Cancel an active scan before removing it.", 409)
    }
    logger.error("Failed to remove scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to remove scan", 500)
  }
}
