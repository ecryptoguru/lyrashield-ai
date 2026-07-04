import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { listInstallationRepos } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")

  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "workspaceId is required" } },
      { status: 400 }
    )
  }

  try {
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)

    const integration = await prisma.integration.findFirst({
      where: {
        workspaceId,
        type: "GITHUB",
        status: "active",
        deletedAt: null,
      },
    })

    if (!integration || !integration.externalId) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_CONNECTED", message: "GitHub App is not connected to this workspace" } },
        { status: 404 }
      )
    }

    const installationId = Number(integration.externalId)
    const repos = await listInstallationRepos(installationId)

    return NextResponse.json({
      success: true,
      data: repos.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        defaultBranch: r.default_branch,
        private: r.private,
        htmlUrl: r.html_url,
      })),
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list GitHub repos", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to list repositories" } },
      { status: 500 }
    )
  }
}
