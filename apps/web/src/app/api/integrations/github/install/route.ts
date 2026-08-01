import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  getInstallAppUrl,
  getAppInstallations,
  exchangeInstallUserCode,
  userCanAdminInstallation,
} from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { createInstallState, verifyInstallState } from "../../../../../lib/github-install-state"

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
  const state = searchParams.get("state")

  if (!installationId || !state) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "MISSING_PARAM", message: "installation_id and state are required" },
      },
      { status: 400 }
    )
  }
  if (!/^[1-9][0-9]*$/.test(installationId) || !Number.isSafeInteger(Number(installationId))) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_INSTALLATION_ID",
          message: "installation_id must be a canonical integer",
        },
      },
      { status: 400 }
    )
  }
  const canonicalInstallationId = String(Number(installationId))

  // The state must be a token this app signed at POST time for a workspace the
  // caller could manage. This prevents tampering `state` to point at another
  // workspace and rejects stale/forged callbacks. (S2)
  const stateResult = verifyInstallState(state)
  if (!stateResult.valid) {
    logger.warn("GitHub install callback rejected — invalid state", { reason: stateResult.reason })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_STATE", message: "Invalid or expired install state" },
      },
      { status: 400 }
    )
  }
  const workspaceId = stateResult.workspaceId

  try {
    const { session: authSession } = await requirePermission(
      workspaceId,
      PERMISSIONS.integration.manage
    )

    const installations = await getAppInstallations()
    const installation = installations.find((i) => i.id === Number(canonicalInstallationId))

    if (!installation) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Installation not found" } },
        { status: 404 }
      )
    }

    // Any prior binding for this installation in this workspace — soft-deleted
    // rows included, so a workspace that disconnected and is reconnecting
    // revives its row instead of colliding with @@unique([type, externalId]).
    // (The `deletedAt: null` reset below was always the intent.)
    const existing = await prisma.integration.findFirst({
      where: {
        workspaceId,
        type: "GITHUB",
        externalId: canonicalInstallationId,
      },
    })

    // A signed state proves the flow started in this workspace from a caller
    // holding `integration:manage`. It does NOT prove the caller administers
    // this app-global, enumerable installation id — so a first-time bind also
    // requires the provider's own assertion. With "Request user authorization
    // (OAuth) during installation" enabled, GitHub appends `code`; exchanging
    // it yields a user token whose /user/installations list is exactly the set
    // that user may act on. Fails closed on a missing code or any error. (S2b)
    if (!existing) {
      const code = searchParams.get("code")
      let ownershipProven = false

      if (!code) {
        logger.warn("GitHub install callback carried no OAuth code", {
          installationId: canonicalInstallationId,
          workspaceId,
        })
      } else {
        try {
          const userToken = await exchangeInstallUserCode(code)
          ownershipProven = await userCanAdminInstallation(
            userToken,
            Number(canonicalInstallationId)
          )
        } catch (err) {
          logger.error("GitHub install ownership verification failed", {
            error: String(err),
            installationId: canonicalInstallationId,
            workspaceId,
          })
        }
      }

      if (!ownershipProven) {
        const redirectUrl = new URL("/dashboard/integrations", request.url)
        redirectUrl.searchParams.set("github", "verification_required")
        return NextResponse.redirect(redirectUrl)
      }
    }

    const metadata = {
      installationId: Number(canonicalInstallationId),
      accountLogin: installation.account.login,
      accountId: installation.account.id,
      accountType: installation.account.type,
      setupAction,
    }

    // AuditLog carries no unique constraints, so a P2002 raised anywhere in this
    // block can only have come from the Integration write.
    try {
      const integration = existing
        ? await prisma.integration.update({
            where: { id: existing.id },
            data: {
              name: installation.account.login,
              status: "active",
              deletedAt: null,
              metadata,
            },
          })
        : await prisma.integration.create({
            data: {
              workspaceId,
              type: "GITHUB",
              externalId: canonicalInstallationId,
              name: installation.account.login,
              status: "active",
              metadata,
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

      logger.info("GitHub App installation connected", {
        installationId: canonicalInstallationId,
        workspaceId,
        account: installation.account.login,
        firstTimeBind: !existing,
      })

      const redirectUrl = new URL("/dashboard/integrations", request.url)
      redirectUrl.searchParams.set("connected", "github")
      return NextResponse.redirect(redirectUrl)
    } catch (err) {
      // @@unique([type, externalId]) — this installation is already bound to a
      // different workspace. Do not disclose which one.
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        logger.warn("GitHub installation already bound to another workspace", {
          installationId: canonicalInstallationId,
          workspaceId,
        })
        const redirectUrl = new URL("/dashboard/integrations", request.url)
        redirectUrl.searchParams.set("github", "already_claimed")
        return NextResponse.redirect(redirectUrl)
      }
      throw err
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to store GitHub installation", {
      error: String(error),
      installationId: canonicalInstallationId,
    })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to connect GitHub installation" },
      },
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
      {
        success: false,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
      },
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
    // Signed, expiring, workspace-bound state (verified in the GET callback). (S2)
    url.searchParams.set("state", createInstallState(workspaceId))

    return NextResponse.json({ success: true, data: { installUrl: url.toString() } })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    // Do not leak the raw error message to the client. (Q7)
    logger.error("Failed to build GitHub install URL", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "CONFIG_ERROR", message: "GitHub App is not configured" } },
      { status: 500 }
    )
  }
}
