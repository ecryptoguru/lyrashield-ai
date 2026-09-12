import { withWorkspaceRLS } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import {
  describeReleaseCheck,
  projectGateReadinessReport,
  RELEASE_ARTIFACT_DIGEST_PATTERN,
  RELEASE_COMMIT_PATTERN,
  type ReleaseIdentityInput,
} from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { z } from "zod"

const ReadinessQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    commit: z.string().regex(RELEASE_COMMIT_PATTERN).optional(),
    artifactDigest: z.string().regex(RELEASE_ARTIFACT_DIGEST_PATTERN).optional(),
  })
  .refine((value) => !(value.commit && value.artifactDigest), {
    message: "commit and artifactDigest are mutually exclusive",
  })

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    // Repeated query values are ambiguous — an identity check must name exactly
    // one release, so duplicates are rejected rather than first-wins.
    for (const param of ["workspaceId", "targetId", "commit", "artifactDigest"]) {
      if (searchParams.getAll(param).length > 1) {
        return apiError("INVALID_PARAM", `${param} may only be supplied once`, 400)
      }
    }
    const parsed = ReadinessQuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId"),
      targetId: searchParams.get("targetId") ?? undefined,
      commit: searchParams.get("commit")?.trim() ?? undefined,
      artifactDigest: searchParams.get("artifactDigest")?.trim() ?? undefined,
    })
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, targetId, commit, artifactDigest } = parsed.data

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const [groups, targets] = await Promise.all([
      withWorkspaceRLS(workspaceId, (tx) =>
        tx.finding.groupBy({
          by: ["severity", "status", "verified"],
          where: {
            workspaceId,
            deletedAt: null,
            ...(targetId ? { targetId } : {}),
          },
          _count: { _all: true },
        })
      ),
      getGateReadinessTargets(workspaceId, targetId, {
        expectedCommit: commit,
        expectedArtifactDigest: artifactDigest,
      }),
    ])

    const report = projectGateReadinessReport(
      groups.map((group) => ({ ...group, count: group._count._all })),
      targets
    )

    // The release check is reported separately from the projected report so a
    // caller can distinguish "the assessment covers this release" (identity
    // match) from "this target is ready" (verdict + applicability). A targetId
    // that resolves to nothing in this workspace returns a cannot-confirm
    // result — existence and identity stay scoped by RLS.
    const requestedIdentity: ReleaseIdentityInput | null = commit
      ? { kind: "COMMIT", value: commit }
      : artifactDigest
        ? { kind: "ARTIFACT_DIGEST", value: artifactDigest }
        : null
    const releaseCheck = targetId
      ? describeReleaseCheck(
          targets.find((target) => target.targetId === targetId) ?? null,
          requestedIdentity
        )
      : null

    const response = apiSuccess({ ...report, releaseCheck })
    response.headers.set("Cache-Control", "no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
