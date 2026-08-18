import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hashLicenseKey } from "../../../../lib/licenses/license-service"

export const dynamic = "force-dynamic"

const CursorQuerySchema = z.object({
  workspaceId: z.string().min(1),
  licenseKey: z.string().min(1).max(200),
})

const CursorUpdateSchema = z.object({
  workspaceId: z.string().min(1),
  licenseKey: z.string().min(1).max(200),
  lastSyncedFindingId: z.string().optional(),
})

/**
 * GET /api/sync/cursor?workspaceId=...&licenseKey=...
 *
 * Retrieve the sync cursor for resumable sync. The desktop client uses this
 * to determine where to resume after a network interruption.
 */
export async function GET(request: Request) {
  try {
    const session = await requireAuth()
    const { searchParams } = new URL(request.url)
    const parsed = CursorQuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId"),
      licenseKey: searchParams.get("licenseKey"),
    })
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, licenseKey } = parsed.data

    // Verify workspace access.
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    const keyHash = hashLicenseKey(licenseKey)
    const licenseKeyRow = await prisma.licenseKey.findUnique({
      where: { keyHash },
      include: { license: { include: { syncCursors: { where: { workspaceId } } } } },
    })
    if (!licenseKeyRow) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }

    const license = licenseKeyRow.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    if (license.syncCursors.length === 0) {
      return apiError("SYNC_NOT_CONNECTED", "Sync has not been established", 409)
    }

    const cursor = license.syncCursors[0]!
    return apiSuccess(
      {
        cursorId: cursor.id,
        lastSyncedAt: cursor.lastSyncedAt.toISOString(),
        lastSyncedFindingId: cursor.lastSyncedFindingId,
      },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Sync cursor GET failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get sync cursor", 500)
  }
}

/**
 * PUT /api/sync/cursor
 *
 * Update the sync cursor after a batch has been processed. This enables
 * resumable sync: if the connection drops mid-batch, the client resumes from
 * the last committed cursor position.
 */
export async function PUT(request: Request) {
  try {
    const session = await requireAuth()
    const body: unknown = await request.json().catch(() => null)
    const parsed = CursorUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, licenseKey, lastSyncedFindingId } = parsed.data

    // Verify workspace access.
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    const keyHash = hashLicenseKey(licenseKey)
    const licenseKeyRow = await prisma.licenseKey.findUnique({
      where: { keyHash },
      include: { license: { include: { syncCursors: { where: { workspaceId } } } } },
    })
    if (!licenseKeyRow) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }

    const license = licenseKeyRow.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    if (license.syncCursors.length === 0) {
      return apiError("SYNC_NOT_CONNECTED", "Sync has not been established", 409)
    }

    const cursor = license.syncCursors[0]!
    const updated = await prisma.syncCursor.update({
      where: { id: cursor.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncedFindingId: lastSyncedFindingId ?? cursor.lastSyncedFindingId,
      },
    })

    return apiSuccess(
      {
        cursorId: updated.id,
        lastSyncedAt: updated.lastSyncedAt.toISOString(),
        lastSyncedFindingId: updated.lastSyncedFindingId,
      },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Sync cursor PUT failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update sync cursor", 500)
  }
}
