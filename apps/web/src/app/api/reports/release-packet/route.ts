import { z } from "zod"
import { generateShareToken, issueReleasePacket, ReleasePacketError } from "@lyrashield/db"
import {
  resolveLaunchReportSigningPrivateKey,
  resolveLaunchReportSigningPublicKey,
  resolveReleasePacketVerificationKeys,
} from "@lyrashield/billing"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { withCookieMutation } from "../../../../lib/api-auth"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

const BodySchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/i, "commit must be a full 40-character SHA")
      .optional(),
    artifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/i, "artifactDigest must be a sha256 digest")
      .optional(),
    share: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.commit) === Boolean(value.artifactDigest)) {
      context.addIssue({
        code: "custom",
        message: "Supply exactly one of commit or artifactDigest",
      })
    }
  })

async function post(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid release packet request",
        400
      )
    }
    const data = parsed.data
    const { session } = await requirePermission(data.workspaceId, PERMISSIONS.report.create)
    assertOAuthDelegatedScope(session, data.targetId)

    const signingPublicKey = await resolveLaunchReportSigningPublicKey().catch((error) => {
      logger.warn("Release packet signing key verification unavailable", {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })
    const [signingPrivateKey, verificationKeys] = await Promise.all([
      resolveLaunchReportSigningPrivateKey().catch(() => null),
      resolveReleasePacketVerificationKeys().catch(() => []),
    ])
    const expectedIdentity = data.commit
      ? { kind: "COMMIT" as const, value: data.commit.toLowerCase() }
      : { kind: "ARTIFACT_DIGEST" as const, value: data.artifactDigest!.toLowerCase() }
    const result = await issueReleasePacket({
      workspaceId: data.workspaceId,
      targetId: data.targetId,
      actorUserId: session.userId,
      expectedIdentity,
      signingPublicKey,
      signingPrivateKey,
      verificationKeys,
    })

    let shareUrl: string | null = null
    if (data.share) {
      const { token } = await generateShareToken(result.reportId, data.workspaceId)
      const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
      const params = new URLSearchParams({ token, workspaceId: data.workspaceId })
      shareUrl = `${base}/reports/release-packet/shared/${result.reportId}?${params.toString()}`
    }

    return apiSuccess(
      {
        reportId: result.reportId,
        packetChecksum: result.payload.packetChecksum,
        shareUrl,
      },
      201
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof ReleasePacketError) {
      const status =
        error.code === "SIGNING_UNAVAILABLE"
          ? 503
          : error.code === "TARGET_NOT_FOUND" || error.code === "NOT_EVALUATED"
            ? 404
            : error.code === "RELEASE_IDENTITY_MISMATCH"
              ? 409
              : 422
      return apiError(error.code, error.message, status)
    }
    logger.error("Release packet generation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create the release packet", 500)
  }
}

export const POST = withCookieMutation(post)
