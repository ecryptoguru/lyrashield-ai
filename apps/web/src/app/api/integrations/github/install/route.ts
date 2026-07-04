import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { getInstallAppUrl, getAppInstallations } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    const loginUrl = new URL("/sign-in", request.url)
    loginUrl.searchParams.set("callbackUrl", "/api/integrations/github/install")
    return NextResponse.redirect(loginUrl)
  }

  const searchParams = request.nextUrl.searchParams
  const installationId = searchParams.get("installation_id")
  const setupAction = searchParams.get("setup_action")
  const workspaceId = searchParams.get("state")

  if (!installationId || !workspaceId) {
    return NextResponse.json(
      { success: false, error: { code: "MISSING_PARAM", message: "installation_id and state are required" } },
      { status: 400 }
    )
  }

  try {
    const { session: authSession } = await requirePermission(workspaceId, PERMISSIONS.integration.manage)

    const installations = await getAppInstallations()
    const installation = installations.find((i) => i.id === Number(installationId))

    if (!installation) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Installation not found" } },
        { status: 404 }
      )
    }

    const integration = await prisma.integration.upsert({
      where: {
        workspaceId_type_externalId: {
          workspaceId,
          type: "GITHUB",
          externalId: String(installationId),
        },
      },
      create: {
        workspaceId,
        type: "GITHUB",
        name: installation.account.login,
        externalId: String(installationId),
        status: "active",
        metadata: {
          installationId: Number(installationId),
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountType: installation.account.type,
          setupAction,
        },
      },
      update: {
        name: installation.account.login,
        status: "active",
        deletedAt: null,
        metadata: {
          installationId: Number(installationId),
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountType: installation.account.type,
          setupAction,
        },
      },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: authSession.userId,
        action: "integration.github.connected",
        resourceType: "integration",
        resourceId: integration.id,
      },
    })

    logger.info("GitHub App installation connected", { installationId, workspaceId, account: installation.account.login })

    const redirectUrl = new URL("/dashboard/integrations", request.url)
    redirectUrl.searchParams.set("connected", "github")
    return NextResponse.redirect(redirectUrl)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to store GitHub installation", { error: String(error), installationId })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to connect GitHub installation" } },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      { status: 401 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      { status: 400 }
    )
  }

  const { workspaceId } = body as { workspaceId?: string }
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "workspaceId is required" } },
      { status: 400 }
    )
  }

  try {
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)

    const installUrl = getInstallAppUrl()
    const url = new URL(installUrl)
    url.searchParams.set("state", workspaceId)

    return NextResponse.json({ success: true, data: { installUrl: url.toString() } })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    return NextResponse.json(
      { success: false, error: { code: "CONFIG_ERROR", message: error instanceof Error ? error.message : "GitHub App not configured" } },
      { status: 500 }
    )
  }
}
