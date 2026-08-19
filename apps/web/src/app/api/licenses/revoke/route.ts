import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export const dynamic = "force-dynamic"

const RevokeSchema = z.object({
  licenseId: z.string().min(1),
  reason: z.string().min(1).max(1000),
})

/**
 * POST /api/licenses/revoke
 *
 * Admin-only (FF4): revoke a license. Sets `revoked=true` on the License row
 * and creates a `LicenseRevocation` record with the reason and revoking key ID.
 *
 * Access control: only the founder (OWNER role on the founding workspace) may
 * revoke licenses. This is enforced by checking the session user's role.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAuth()

    // Founder-only: the user must be an OWNER on at least one workspace.
    // This is the strictest gate — only the founder can revoke licenses.
    const ownerMembership = await prisma.workspaceMember.findFirst({
      where: { userId: session.userId, role: "OWNER", status: "active" },
    })
    if (!ownerMembership) {
      return apiError("FORBIDDEN", "Only the founder (OWNER) may revoke licenses", 403)
    }

    const body: unknown = await request.json().catch(() => null)
    const parsed = RevokeSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { licenseId, reason } = parsed.data

    const license = await prisma.license.findUnique({ where: { id: licenseId } })
    if (!license) {
      return apiError("LICENSE_NOT_FOUND", "License not found", 404)
    }
    if (license.revoked) {
      return apiError("ALREADY_REVOKED", "This license is already revoked", 409)
    }

    // B-M06: Full revocation — nullify signature, deactivate activations,
    // and delete sync cursors so the revoked license cannot be used offline
    // or for further sync. The offline client verifies the signature locally
    // (grace), so nullifying the signature forces re-verification which will
    // fail. Sync cursors are deleted so no further findings can be synced.
    //
    // POLICY (founder-confirmed 2026-08-19): revocation is a HARD STOP. It
    // overrides the perpetual-fallback guarantee — `perpetualFallbackBuild`
    // only ever governs *update eligibility after a license lapses*, never
    // "keep running after an explicit revocation." A revoked license must not
    // run any build, including its fallback build. Do not soften this without
    // an explicit founder decision reversing it.
    await prisma.$transaction(async (tx) => {
      await tx.license.update({
        where: { id: licenseId },
        data: {
          revoked: true,
          revokedAt: new Date(),
          // Nullify the signature so offline verification fails
          signature: "REVOKED",
          signingKeyId: "REVOKED",
        },
      })
      await tx.licenseRevocation.create({
        data: {
          licenseId,
          revokedAt: new Date(),
          reason,
          revokedByKeyId: session.userId,
        },
      })
      // Deactivate all active machine activations
      await tx.licenseActivation.updateMany({
        where: { licenseId, deactivatedAt: null },
        data: { deactivatedAt: new Date() },
      })
      // Delete sync cursors so no further sync is possible
      await tx.syncCursor.deleteMany({
        where: { licenseId },
      })
    })

    logger.warn("License revoked", {
      licenseId,
      reason,
      revokedBy: session.userId,
    })

    return apiSuccess({ licenseId, revoked: true }, 200)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("License revocation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revoke license", 500)
  }
}
