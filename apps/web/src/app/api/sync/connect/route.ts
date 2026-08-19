import { z } from "zod"
import { prisma, getSystemPrisma } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { type LocalSkuId } from "@lyrashield/pricing"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hashLicenseKey } from "../../../../lib/licenses/license-service"

export const dynamic = "force-dynamic"

const ConnectSchema = z.object({
  /** The workspace to link sync to. */
  workspaceId: z.string().min(1),
  /** License key proving sync entitlement (the $49/yr sync_addon or a Cloud sub). */
  licenseKey: z.string().min(1).max(200),
})

/**
 * POST /api/sync/connect
 *
 * Link a Local license to a LyraShield workspace for cloud sync. The server
 * enforces sync entitlement server-side: the license must either be a Cloud
 * subscription OR have the $49/yr `sync_addon` SKU.
 *
 * H-01: The caller must provide the raw license KEY (not just the ID) as
 * proof of ownership. The key is hashed and verified against the LicenseKey
 * record. Additionally, if the license is already linked to a different
 * workspace, the caller must also be a member of that workspace — this
 * prevents an attacker with a stolen key from hijacking the license to
 * their own workspace.
 *
 * The desktop client calls this once during setup; subsequent sync batches
 * use the established SyncCursor.
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

    // Verify the user has access to the workspace.
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    // H-01: Look up the license by key hash — this proves the caller possesses
    // the actual license key, not just the ID.
    // Sync connect resolves a license by key hash — a workspace-less global
    // lookup (the license may not be linked to the caller's workspace yet).
    // Use the system client (cross-workspace privileged read) since the
    // FORCE-RLS-scoped client would not find NULL-workspaceId keys under a
    // NOBYPASSRLS role.
    const systemPrisma = getSystemPrisma()
    const keyHash = hashLicenseKey(licenseKey)
    const licenseKeyRow = await systemPrisma.licenseKey.findUnique({
      where: { keyHash },
      include: { license: true },
    })
    if (!licenseKeyRow) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }

    const license = licenseKeyRow.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    // H-01: Prevent license hijacking. If the license is already linked to a
    // different workspace, the caller must also be a member of that workspace
    // to re-link it. This prevents a user with a stolen key from hijacking
    // someone else's license into their own workspace.
    if (license.workspaceId && license.workspaceId !== workspaceId) {
      const owningMembership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: license.workspaceId, userId: session.userId },
        },
      })
      if (!owningMembership || owningMembership.status !== "active") {
        return apiError(
          "LICENSE_ALREADY_LINKED",
          "This license is already linked to another workspace. " +
            "Contact the workspace owner to transfer it.",
          403
        )
      }
    }

    // Server-side entitlement check: Cloud subscription OR sync_addon.
    const sku = license.sku as LocalSkuId
    const hasSyncEntitlement = await checkSyncEntitlement(sku, license.workspaceId, workspaceId)
    if (!hasSyncEntitlement) {
      return apiError(
        "SYNC_NOT_ENTITLED",
        "Cloud sync requires an active Cloud subscription or the $49/yr Cloud Sync Add-on. " +
          "Purchase the add-on from your LyraShield account settings.",
        402
      )
    }

    // Link the license to the workspace if not already linked.
    if (license.workspaceId !== workspaceId) {
      await prisma.license.update({
        where: { id: license.id },
        data: { workspaceId },
      })
    }

    // Create or update the SyncCursor.
    const cursor = await prisma.syncCursor.upsert({
      where: { workspaceId_licenseId: { workspaceId, licenseId: license.id } },
      create: {
        workspaceId,
        licenseId: license.id,
        lastSyncedAt: new Date(),
      },
      update: {
        lastSyncedAt: new Date(),
      },
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

/**
 * Check whether the license SKU or workspace plan grants sync entitlement.
 *
 * - `sync_addon` SKU: explicitly entitled.
 * - Team subscription: sync is included.
 * - Cloud workspace plan (STARTER+): entitled via the workspace.
 * - Individual / team_perpetual without add-on: NOT entitled.
 *
 * B-M08: Now async — checks the workspace plan for Cloud subscription
 * entitlement and verifies the license belongs to the target workspace.
 */
async function checkSyncEntitlement(
  sku: LocalSkuId,
  licenseWorkspaceId: string | null,
  targetWorkspaceId: string
): Promise<boolean> {
  // The sync_addon SKU explicitly grants sync.
  if (sku === "sync_addon") return true

  // Team subscription includes sync.
  if (sku === "team_subscription") return true

  // B-M08: Check if the target workspace has an active Cloud subscription
  // (STARTER or above). This entitles the workspace to sync even without
  // a separate sync_addon license.
  const workspace = await prisma.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { plan: true },
  })

  if (workspace && workspace.plan !== "FREE") {
    // Cloud subscribers are entitled to sync
    return true
  }

  // B-M08: Verify the license is associated with the target workspace
  // (prevents using a license from workspace A to sync to workspace B)
  if (licenseWorkspaceId && licenseWorkspaceId !== targetWorkspaceId) {
    return false
  }

  return false
}
