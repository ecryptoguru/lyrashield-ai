import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { withWorkspaceRLS, findLicenseForSyncByKeyHash } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { type LocalSkuId } from "@lyrashield/pricing"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hashLicenseKey } from "../../../../lib/licenses/license-service"
import { hasSyncWriteAccess } from "../../../../lib/sync-auth"

export const dynamic = "force-dynamic"

const ConnectSchema = z.object({
  workspaceId: z.string().min(1),
  licenseKey: z.string().min(1).max(200),
})

/**
 * POST /api/sync/connect
 *
 * Native-keychain-backed authenticated sync connect. Requires an authenticated session
 * (requireAuth) AND proof-of-possession of the raw license key (hashed and
 * resolved via narrow privileged adapter). The raw key is never logged nor
 * returned. All cursor writes are bound to the authenticated workspace via
 * withWorkspaceRLS (NOBYPASSRLS-safe).
 *
 * SyncCursor now carries a monotonic `seq` (BIGINT) for CAS. connect returns
 * the current seq so the desktop's trusted native store can seed its cursor.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAuth()
    const body: unknown = await request.json().catch(() => null)
    const parsed = ConnectSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, licenseKey } = parsed.data

    if (!hasSyncWriteAccess(session, workspaceId)) {
      return apiError("FORBIDDEN", "A write-capable key for this workspace is required", 403)
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    // Narrow privileged lookup — single purpose, minimal projection
    const keyHash = hashLicenseKey(licenseKey)
    const row = await findLicenseForSyncByKeyHash(keyHash)
    if (!row) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }
    const license = row.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    if (license.workspaceId && license.workspaceId !== workspaceId) {
      const owningMembership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: license.workspaceId, userId: session.userId },
        },
      })
      if (!owningMembership || owningMembership.status !== "active") {
        return apiError(
          "LICENSE_ALREADY_LINKED",
          "This license is already linked to another workspace. Contact the workspace owner to transfer it.",
          403
        )
      }
    }

    const sku = license.sku as LocalSkuId
    const hasSyncEntitlement = await checkSyncEntitlement(sku, license.workspaceId, workspaceId)
    if (!hasSyncEntitlement) {
      return apiError(
        "SYNC_NOT_ENTITLED",
        "Cloud sync requires an active Cloud subscription or the $49/yr Cloud Sync Add-on.",
        402
      )
    }

    if (license.workspaceId !== workspaceId) {
      // License workspace linkage is a privileged cross-workspace write (license row is not RLS-scoped).
      // Use direct prisma (not workspace-RLS) for this single column update; cursor RLS is separate.
      await prisma.license.update({
        where: { id: license.id },
        data: { workspaceId },
      })
    }

    // Cursor create/update must be workspace-bound (withWorkspaceRLS) so NOBYPASSRLS role cannot leak.
    const cursor = await withWorkspaceRLS(workspaceId, async (tx) => {
      const existing = await tx.syncCursor.findUnique({
        where: { workspaceId_licenseId: { workspaceId, licenseId: license.id } },
      })
      if (existing) {
        // Touch lastSyncedAt but preserve seq
        return tx.syncCursor.update({
          where: { id: existing.id },
          data: { lastSyncedAt: new Date() },
        })
      }
      return tx.syncCursor.create({
        data: {
          workspaceId,
          licenseId: license.id,
          seq: BigInt(0),
          lastSyncedAt: new Date(),
        },
      })
    })

    logger.info("Sync connected", {
      licenseId: license.id,
      workspaceId,
      userId: session.userId,
    })

    return apiSuccess(
      {
        connected: true,
        syncCursorId: cursor.id,
        licenseId: license.id,
        seq: Number(cursor.seq),
        lastSyncedAt: cursor.lastSyncedAt.toISOString(),
        lastSyncedFindingId: cursor.lastSyncedFindingId ?? null,
      },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Sync connect failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to connect sync", 500)
  }
}

async function checkSyncEntitlement(
  sku: LocalSkuId,
  licenseWorkspaceId: string | null,
  targetWorkspaceId: string
): Promise<boolean> {
  if (sku === "sync_addon") return true
  if (sku === "team_subscription") return true
  const workspace = await prisma.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { plan: true },
  })
  if (workspace && workspace.plan !== "FREE") return true
  if (licenseWorkspaceId && licenseWorkspaceId !== targetWorkspaceId) return false
  return false
}
