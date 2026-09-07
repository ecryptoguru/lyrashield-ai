import { withWorkspaceRLS } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import { projectGateReadinessReport } from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { z } from "zod"

const ReadinessQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    artifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/i)
      .optional(),
  })
  .refine((value) => !(value.commit && value.artifactDigest), {
    message: "commit and artifactDigest are mutually exclusive",
  })

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const parsed = ReadinessQuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId"),
      targetId: searchParams.get("targetId") ?? undefined,
      commit: searchParams.get("commit") ?? undefined,
      artifactDigest: searchParams.get("artifactDigest") ?? undefined,
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

    const response = apiSuccess(report)
    response.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
