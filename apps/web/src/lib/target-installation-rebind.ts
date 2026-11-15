import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { getDefaultBranch } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { apiError } from "./api-response"

/**
 * Rebind a repository target to another active GitHub App installation of the
 * same workspace. Scanned revisions stay pinned in each scan's immutable plan,
 * so rebinding the transport never rewrites scan provenance. Only an owned
 * installation that actually reaches the exact repository may be bound.
 */
export async function rebindTargetInstallation(params: {
  workspaceId: string
  actorUserId: string
  targetId: string
  installationId: string
}): Promise<Response> {
  const { workspaceId, actorUserId, targetId, installationId } = params
  const target = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true, type: true, repoFullName: true, installationId: true },
    })
  )
  if (!target) {
    return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
  }
  if (target.type !== "REPO") {
    return apiError(
      "INVALID_TARGET_TYPE",
      "A GitHub connection can only be bound to a repository target",
      400
    )
  }
  const [owner, repo] = (target.repoFullName ?? "").split("/")
  if (!owner || !repo) {
    return apiError("INVALID_TARGET_TYPE", "This target has no valid repository name", 400)
  }
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
    tx.target.update({ where: { id: targetId }, data: { installationId } })
  )
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorUserId,
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
