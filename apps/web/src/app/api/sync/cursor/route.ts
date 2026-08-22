import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { withWorkspaceRLS, findLicenseForSyncByKeyHash } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hashLicenseKey } from "../../../../lib/licenses/license-service"
import { hasSyncWriteAccess } from "../../../../lib/sync-auth"

export const dynamic = "force-dynamic"

const CursorUpdateSchema = z.object({
  workspaceId: z.string().min(1),
  licenseKey: z.string().min(1).max(200),
  // Monotonic numeric cursor
  seq: z.number().int().min(0).optional(),
  // Legacy alias (string numeric) — accept but coerce
  expectedSeq: z.number().int().min(0).optional(),
  lastSyncedFindingId: z.string().optional(),
})

/**
 * GET /api/sync/cursor
 *
 * Legacy URL cursor reads are intentionally rejected. License keys must never
 * travel in query strings; use authenticated PUT with no requested advance.
 */
export async function GET() {
  return apiError(
    "METHOD_NOT_SUPPORTED",
    "Use authenticated PUT /api/sync/cursor; license keys are not accepted in URLs.",
    405
  )
}

/**
 * PUT /api/sync/cursor
 *
 * Monotonic seq advancement only. Rejects any attempt to move seq backwards (rewind)
 * or to set lastSyncedFindingId without advancing seq via the findings CAS path.
 * Direct cursor writes cannot carry findings; use POST /findings for evidence.
 */
export async function PUT(request: Request) {
  try {
    const session = await requireAuth()
    const body: unknown = await request.json().catch(() => null)
    const parsed = CursorUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, licenseKey } = parsed.data
    if (!hasSyncWriteAccess(session, workspaceId)) {
      return apiError("FORBIDDEN", "A write-capable key for this workspace is required", 403)
    }
    const requestedSeq = parsed.data.seq ?? parsed.data.expectedSeq
    const { lastSyncedFindingId } = parsed.data

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    const keyHash = hashLicenseKey(licenseKey)
    const row = await findLicenseForSyncByKeyHash(keyHash)
    if (!row) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }
    const license = row.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    const cursor = await withWorkspaceRLS(workspaceId, async (tx) =>
      tx.syncCursor.findUnique({
        where: { workspaceId_licenseId: { workspaceId, licenseId: license.id } },
      })
    )
    if (!cursor) {
      return apiError("SYNC_NOT_CONNECTED", "Sync has not been established", 409)
    }

    const currentSeq = Number(cursor.seq)

    // If client requests explicit seq, enforce monotonicity
    if (requestedSeq !== undefined) {
      if (requestedSeq < currentSeq) {
        logger.warn("Sync cursor rewind attempt rejected", {
          cursorId: cursor.id,
          current: currentSeq,
          attempted: requestedSeq,
          userId: session.userId,
        })
        return apiError("CURSOR_REWIND", "Cursor cannot move backwards", 409, undefined, {
          currentSeq,
          requestedSeq,
        })
      }
      if (requestedSeq === currentSeq) {
        // No-op — touch timestamp
        const updated = await withWorkspaceRLS(workspaceId, async (tx) =>
          tx.syncCursor.update({ where: { id: cursor.id }, data: { lastSyncedAt: new Date() } })
        )
        return apiSuccess(
          {
            cursorId: updated.id,
            seq: Number(updated.seq),
            cursor: String(updated.seq),
            lastSyncedAt: updated.lastSyncedAt.toISOString(),
            lastSyncedFindingId: updated.lastSyncedFindingId,
          },
          200
        )
      }
      // Forward jump without findings is not allowed — findings CAS is the only valid advance
      return apiError(
        "CURSOR_FORWARD_JUMP",
        "Cursor can only advance via POST /api/sync/findings",
        409,
        undefined,
        {
          currentSeq,
          requestedSeq,
        }
      )
    }

    // Legacy lastSyncedFindingId-only update: reject unless already equal (no-op)
    if (lastSyncedFindingId !== undefined) {
      if (lastSyncedFindingId === cursor.lastSyncedFindingId) {
        const updated = await withWorkspaceRLS(workspaceId, async (tx) =>
          tx.syncCursor.update({ where: { id: cursor.id }, data: { lastSyncedAt: new Date() } })
        )
        return apiSuccess(
          {
            cursorId: updated.id,
            seq: Number(updated.seq),
            cursor: String(updated.seq),
            lastSyncedAt: updated.lastSyncedAt.toISOString(),
            lastSyncedFindingId: updated.lastSyncedFindingId,
          },
          200
        )
      }
      return apiError(
        "CURSOR_UPDATE_REJECTED",
        "Cursor position can only be updated via findings sync",
        409
      )
    }

    // No fields to update — return current
    return apiSuccess(
      {
        cursorId: cursor.id,
        seq: currentSeq,
        cursor: String(currentSeq),
        lastSyncedAt: cursor.lastSyncedAt.toISOString(),
        lastSyncedFindingId: cursor.lastSyncedFindingId,
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
