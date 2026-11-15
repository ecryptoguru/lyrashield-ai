import { withCookieMutation } from "../../../../lib/api-auth"
import { NextResponse } from "next/server"
import {
  prisma,
  softDeleteTarget,
  TargetHasActiveScanError,
  TargetNotFoundError,
  withWorkspaceRLS,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { purgeAiResultCacheWorkspaceEntries, getDefaultBranch } from "@lyrashield/integrations"
import { PatchTargetSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { revalidateDashboardAggregates } from "../../../../lib/cache"
import { checkScanUrlSafe } from "../../../../lib/ssrf"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"

async function patch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
      },
      { status: 400 }
    )
  }

  const parsed = PatchTargetSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 }
    )
  }

  const { workspaceId } = parsed.data
  const { id } = await params

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.target.update)

    if ("branch" in parsed.data) {
      const branch = parsed.data.branch
      const outcome = await withWorkspaceRLS(workspaceId, async (tx) => {
        // createScan takes this same lock before inserting. Reading and updating
        // under it makes the repository ref immutable at the first scan boundary.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`
        const target = await tx.target.findFirst({
          where: { id, workspaceId, deletedAt: null },
          select: { id: true, type: true, branch: true, _count: { select: { scans: true } } },
        })
        if (!target) return { kind: "not_found" as const }
        if (target.type !== "REPO") return { kind: "invalid_type" as const }
        if (target._count.scans !== 0) return { kind: "immutable" as const }

        await tx.target.update({ where: { id }, data: { branch } })
        return { kind: "updated" as const, target }
      })

      if (outcome.kind === "not_found") {
        return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
      }
      if (outcome.kind === "invalid_type") {
        return apiError("INVALID_TARGET_TYPE", "Branch or tag can only be set on REPO targets", 400)
      }
      if (outcome.kind === "immutable") {
        return apiError(
          "TARGET_REF_IMMUTABLE",
          "Branch or tag cannot be changed after the first scan is created",
          409
        )
      }

      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: session.userId,
          action: "target.repo_ref_updated",
          resourceType: "target",
          resourceId: outcome.target.id,
          metadata: { previousRef: outcome.target.branch, ref: branch },
        },
      })

      logger.info("Target repository ref updated", {
        targetId: outcome.target.id,
        workspaceId,
      })

      return NextResponse.json({
        success: true,
        data: { id: outcome.target.id, type: outcome.target.type, branch },
      })
    }

    const target = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.findFirst({
        where: { id, workspaceId, deletedAt: null },
        select: {
          id: true,
          type: true,
          apiSpecUrl: true,
          branch: true,
          repoFullName: true,
          installationId: true,
        },
      })
    )
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    if ("installationId" in parsed.data) {
      // Reconnection: only an active GitHub integration of THIS workspace may
      // be bound, and it must actually reach the exact repository. The scanned
      // revision stays pinned in each scan's immutable plan, so rebinding the
      // transport never rewrites scan provenance.
      if (target.type !== "REPO" || !target.repoFullName) {
        return apiError(
          "INVALID_TARGET_TYPE",
          "A GitHub connection can only be bound to a repository target",
          400
        )
      }
      const installationId = parsed.data.installationId
      const integration = await prisma.integration.findFirst({
        where: {
          workspaceId,
          type: "GITHUB",
          externalId: installationId,
          status: "active",
          deletedAt: null,
        },
        select: { externalId: true },
      })
      if (!integration) {
        return apiError(
          "INSTALLATION_NOT_FOUND",
          "The selected GitHub connection is not an active integration for this workspace",
          400
        )
      }
      const [owner, repo] = target.repoFullName.split("/")
      if (!owner || !repo) {
        return apiError("INVALID_TARGET_TYPE", "This target has no valid repository name", 400)
      }
      try {
        await getDefaultBranch(Number(installationId), owner, repo)
      } catch (providerError) {
        logger.warn("Selected GitHub connection cannot reach the target repository", {
          targetId: target.id,
          workspaceId,
          errorType: providerError instanceof Error ? providerError.name : "unknown",
        })
        return apiError(
          "INSTALLATION_REPOSITORY_ACCESS_DENIED",
          "That GitHub connection cannot access this repository. Grant it access on GitHub, then choose it again.",
          400
        )
      }

      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.target.update({ where: { id }, data: { installationId } })
      )
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: session.userId,
          action: "target.github_installation_rebound",
          resourceType: "target",
          resourceId: target.id,
          metadata: { previousInstallationId: target.installationId, installationId },
        },
      })
      logger.info("Target GitHub installation rebound", { targetId: target.id, workspaceId })
      return NextResponse.json({
        success: true,
        data: { id: target.id, type: target.type, installationId },
      })
    }

    const { apiSpecUrl } = parsed.data
    if (target.type !== "API") {
      return apiError("INVALID_TARGET_TYPE", "OpenAPI URL can only be set on API targets", 400)
    }

    if (apiSpecUrl) {
      const ssrf = await checkScanUrlSafe(apiSpecUrl)
      if (!ssrf.safe) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "SSRF_BLOCKED",
              message:
                "This OpenAPI URL is not allowed (it targets an internal, private or unresolvable address).",
            },
          },
          { status: 400 }
        )
      }
    }

    const updated = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.update({ where: { id }, data: { apiSpecUrl } })
    )

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "target.api_spec_updated",
        resourceType: "target",
        resourceId: target.id,
        metadata: { apiSpecUrl: apiSpecUrl ?? null },
      },
    })

    logger.info("Target OpenAPI URL updated", { targetId: target.id, workspaceId })

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        type: updated.type,
        apiSpecUrl: updated.apiSpecUrl,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update target", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update target", 500)
  }
}

export const PATCH = withCookieMutation(patch)

const WorkspaceSchema = z.string().min(1)

async function deleteTarget(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsedWorkspace = WorkspaceSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )
  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspace.data
  const { id } = await params

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.target.delete)
    await softDeleteTarget(workspaceId, id, session.userId)
    try {
      await purgeAiResultCacheWorkspaceEntries(workspaceId, [id])
    } catch (purgeError) {
      // The target is already soft-deleted and cannot be scanned again. Cache
      // entries expire absolutely; Redis failure must not undo the deletion.
      logger.warn("Exact AI-result cache purge failed after target deletion", {
        errorType: purgeError instanceof Error ? purgeError.name : "unknown",
      })
    }
    logger.info("Target soft-deleted", { targetId: id, workspaceId, actorUserId: session.userId })
    revalidateDashboardAggregates(workspaceId)
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (error instanceof TargetNotFoundError) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }
    if (error instanceof TargetHasActiveScanError) {
      return apiError(
        "TARGET_HAS_ACTIVE_SCAN",
        "This target has a queued or running scan. Wait for it to finish or cancel it before deleting.",
        409
      )
    }
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to delete target", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to delete target", 500)
  }
}

export const DELETE = withCookieMutation(deleteTarget)
