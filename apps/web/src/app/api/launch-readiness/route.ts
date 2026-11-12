import { withWorkspaceRLS } from "@lyrashield/db"
import { requirePermission, resolveOAuthReadScope } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import {
  describeReleaseCheck,
  projectGateReadinessReport,
  RELEASE_ARTIFACT_DIGEST_PATTERN,
  RELEASE_COMMIT_PATTERN,
  resolveReleaseCheckTargetId,
  type ReleaseIdentityInput,
} from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { z } from "zod"

const ReadinessQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    cursor: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    commit: z
      .string()
      .regex(RELEASE_COMMIT_PATTERN)
      .transform((value) => value.toLowerCase())
      .optional(),
    artifactDigest: z
      .string()
      .regex(RELEASE_ARTIFACT_DIGEST_PATTERN)
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .refine((value) => !(value.commit && value.artifactDigest), {
    message: "commit and artifactDigest are mutually exclusive",
  })

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    // Repeated query values are ambiguous — an identity check must name exactly
    // one release, so duplicates are rejected rather than first-wins.
    for (const param of ["workspaceId", "targetId", "commit", "artifactDigest", "cursor"]) {
      if (searchParams.getAll(param).length > 1) {
        return apiError("INVALID_PARAM", `${param} may only be supplied once`, 400)
      }
    }
    const parsed = ReadinessQuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId"),
      targetId: searchParams.get("targetId") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      commit: searchParams.get("commit")?.trim() ?? undefined,
      artifactDigest: searchParams.get("artifactDigest")?.trim() ?? undefined,
    })
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, targetId, commit, artifactDigest, cursor } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.finding.view)
    resolveOAuthReadScope(session, targetId, true)

    const requestedIdentity: ReleaseIdentityInput | null = commit
      ? { kind: "COMMIT", value: commit }
      : artifactDigest
        ? { kind: "ARTIFACT_DIGEST", value: artifactDigest }
        : null
    const identityOptions = {
      expectedCommit: commit,
      expectedArtifactDigest: artifactDigest,
    }

    // A release identity without a target may be auto-scoped only when the
    // workspace has one authorized target. Read the target list without an
    // expected identity first so one reference is never evaluated across
    // several unrelated targets.
    let effectiveTargetId = targetId
    let targets
    let pageTargets
    if (!targetId && requestedIdentity) {
      const allTargets = cursor
        ? await getGateReadinessTargets(workspaceId, undefined, {}, cursor)
        : await getGateReadinessTargets(workspaceId)
      pageTargets = allTargets
      effectiveTargetId = resolveReleaseCheckTargetId(
        "",
        true,
        allTargets.partial ? [] : allTargets.map((target) => target.targetId)
      )
      if (effectiveTargetId) {
        targets = await getGateReadinessTargets(workspaceId, effectiveTargetId, identityOptions)
      } else {
        targets = allTargets
      }
    } else {
      targets =
        cursor && !targetId
          ? await getGateReadinessTargets(workspaceId, targetId, identityOptions, cursor)
          : await getGateReadinessTargets(workspaceId, targetId, identityOptions)
      // Restricted OAuth grants may read only their explicitly granted target.
      pageTargets =
        targetId && !(session.oauth?.connectionId && !session.oauth.allTargets)
          ? await getGateReadinessTargets(workspaceId, undefined, {}, cursor)
          : targets
    }

    const groups = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.groupBy({
        by: ["severity", "status", "verified"],
        where: {
          workspaceId,
          deletedAt: null,
          ...(effectiveTargetId
            ? { targetId: effectiveTargetId }
            : { targetId: { in: targets.map((target) => target.targetId) } }),
        },
        _count: { _all: true },
      })
    )

    const report = projectGateReadinessReport(
      groups.map((group) => ({ ...group, count: group._count._all })),
      targets,
      { partial: targets.partial }
    )

    // The release check is reported separately from the projected report so a
    // caller can distinguish "the assessment covers this release" (identity
    // match) from "this target is ready" (verdict + applicability). A targetId
    // that resolves to nothing in this workspace returns a cannot-confirm
    // result — existence and identity stay scoped by RLS.
    const releaseCheck = effectiveTargetId
      ? describeReleaseCheck(
          targets.find((target) => target.targetId === effectiveTargetId) ?? null,
          requestedIdentity
        )
      : null

    const targetOptions = pageTargets.map((target) => ({
      targetId: target.targetId,
      targetName: target.targetName,
    }))
    if (
      effectiveTargetId &&
      !targetOptions.some((target) => target.targetId === effectiveTargetId)
    ) {
      const selected = targets.find((target) => target.targetId === effectiveTargetId)
      if (selected)
        targetOptions.push({ targetId: selected.targetId, targetName: selected.targetName })
    }
    const response = apiSuccess({
      ...report,
      releaseCheck,
      targets: targetOptions,
      nextCursor: pageTargets.nextCursor ?? null,
      partial: pageTargets.partial ?? false,
    })
    response.headers.set("Cache-Control", "no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
