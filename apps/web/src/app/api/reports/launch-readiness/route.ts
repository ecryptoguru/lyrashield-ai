import { withCookieMutation } from "../../../../lib/api-auth"
import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { generateLaunchReport, generateShareToken } from "@lyrashield/db"
import { resolveLaunchReportSigningPrivateKey } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

const GenerateSchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1),
    /** Customer-opted-in app display name. Omit for the neutral label. */
    appDisplayName: z.string().max(120).optional(),
    /** When true, also create a share link (30-day validity). */
    share: z.boolean().optional().default(false),
  })
  .strict()

/**
 * POST /api/reports/launch-readiness — generate (and optionally share) a Launch
 * Readiness Report for a target from its latest gate verdict.
 *
 * The public payload is built only through buildLaunchReportPayload (the
 * allowlist constructor). When the signing key is configured the payload is
 * ed25519-signed; the key is resolved by the deployment (env in dev, Azure Key
 * Vault in production) and injected — never read from the request. A report
 * issued without a key is unsigned and the verify endpoint reports it as
 * unavailable, never a guess.
 */
async function post(request: Request) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
    }
    const parsed = GenerateSchema.safeParse(body)
    if (!parsed.success) {
      logger.warn("Launch report generation validation error", { errors: parsed.error.issues })
      return apiError("VALIDATION_ERROR", "Invalid request body", 400)
    }
    const { workspaceId, targetId, appDisplayName, share } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.create)

    // Resolve the signing key server-side (env in dev, Key Vault in prod). Null
    // means unsigned — the report still issues, marked as such.
    const signingPrivateKey = await resolveLaunchReportSigningPrivateKey().catch((error) => {
      logger.error("Launch report signing key resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })

    const result = await generateLaunchReport(workspaceId, targetId, session.userId, {
      appDisplayName,
      signingPrivateKey: signingPrivateKey ?? undefined,
    })
    if (!result) {
      return apiError(
        "NOT_EVALUATED",
        "No gate verdict exists for this target yet. Run the launch gate first.",
        404
      )
    }

    let shareUrl: string | null = null
    if (share) {
      const { token } = await generateShareToken(result.reportId, workspaceId)
      const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
      shareUrl = `${base}/reports/shared/${result.reportId}?token=${token}`
    }

    return apiSuccess(
      {
        reportId: result.reportId,
        verdict: result.payload.verdictLabel,
        signed: Boolean(result.payload.signature),
        stale: result.payload.stale,
        shareUrl,
      },
      201
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Launch report generation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to generate the launch readiness report", 500)
  }
}

export const POST = withCookieMutation(post)
