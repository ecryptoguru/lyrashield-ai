import { verifyOAuthOnboardingReturn } from "@/lib/oauth-onboarding-return"
import { withCookieMutation } from "../../../../../lib/api-auth"
import { NextResponse, type NextRequest } from "next/server"
import { env } from "@lyrashield/config"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  getInstallAppUrl,
  getAppInstallations,
  exchangeInstallUserCode,
  userCanAdminInstallation,
  connectorScopesForInstallationPermissions,
  listInstallationRepos,
} from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { createInstallState, verifyInstallState } from "../../../../../lib/github-install-state"
import { z } from "zod"

const InstallRequestSchema = z.object({
  workspaceId: z.string().min(1),
  oauthReturnState: z.string().max(8192).optional(),
  returnTo: z.enum(["onboarding", "integrations"]).default("integrations"),
})

function installReturnPath(returnTo: "onboarding" | "integrations"): string {
  return returnTo === "onboarding" ? "/onboarding" : "/dashboard/integrations"
}

/**
 * Returns the canonical, browser-safe app origin for post-install redirects.
 * Falls back to the incoming request origin, and normalises loopback addresses
 * (0.0.0.0 / 127.0.0.1 / ::1) to `localhost` with plain HTTP so local dev
 * callbacks don't resolve to an invalid `https://0.0.0.0:3000` page.
 */
function getAppOrigin(request: NextRequest): URL {
  const configured = env.NEXT_PUBLIC_APP_URL || env.BETTER_AUTH_URL
  const base = configured ? new URL(configured) : new URL(request.url)

  if (
    base.hostname === "0.0.0.0" ||
    base.hostname === "127.0.0.1" ||
    base.hostname === "::1" ||
    base.hostname === "[::]"
  ) {
    base.hostname = "localhost"
    if (base.protocol === "https:") {
      base.protocol = "http:"
    }
  }

  // Drop any path so callers use this as a clean origin base.
  base.pathname = "/"
  base.search = ""
  base.hash = ""
  return base
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    const loginUrl = new URL("/sign-in", getAppOrigin(request))
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
  let returnPath = installReturnPath(stateResult.returnTo)
  const oauthReturn = stateResult.oauthReturnState
    ? verifyOAuthOnboardingReturn(stateResult.oauthReturnState)
    : null
  if (
    stateResult.returnTo === "onboarding" &&
    oauthReturn?.valid &&
    oauthReturn.userId === session.userId
  ) {
    returnPath += `?oauth_return=${encodeURIComponent(stateResult.oauthReturnState!)}`
  }

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
        const redirectUrl = new URL(returnPath, getAppOrigin(request))
        redirectUrl.searchParams.set("github", "verification_required")
        return NextResponse.redirect(redirectUrl)
      }
    }

    // The recorded grant must reflect what the provider actually granted.
    // Connector tools fail closed on `capabilities.scopes`, so derive them
    // from the installation's permission set — never invent scopes here.
    //
    // Resource scoping decision (stale-selection safety): an installation
    // with repository_selection "all" reaches every current and future repo
    // provider-side, so the grant stays resource-unconstrained — a stored
    // list would be stale-narrow immediately and could never widen access.
    // For "selected" (and for any missing or unrecognized value — the
    // narrower reading fails closed) the grant snapshots the provider's own
    // repository list. Repos added to the selection later deny until the
    // workspace reconnects; repos removed provider-side keep denying at the
    // GitHub API even while the snapshot still names them, so a stale
    // snapshot cannot widen effective access.
    const scopes = connectorScopesForInstallationPermissions(installation.permissions)
    const repositorySelection = installation.repository_selection === "all" ? "all" : "selected"
    let resources: string[] | undefined
    if (repositorySelection === "selected") {
      const repos = await listInstallationRepos(Number(canonicalInstallationId))
      resources = repos.map((repo) => `repo:${repo.full_name}`)
    }
    const capabilities = {
      scopes,
      ...(resources !== undefined ? { resources } : {}),
    }

    const metadata = {
      installationId: Number(canonicalInstallationId),
      accountLogin: installation.account.login,
      accountId: installation.account.id,
      accountType: installation.account.type,
      repositorySelection,
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
              capabilities,
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
              capabilities,
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

      const redirectUrl = new URL(returnPath, getAppOrigin(request))
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
        const redirectUrl = new URL(returnPath, getAppOrigin(request))
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

async function post(request: NextRequest) {
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

  const parsed = InstallRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        },
      },
      { status: 400 }
    )
  }
  const { workspaceId, returnTo, oauthReturnState } = parsed.data

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.integration.manage)
    if (oauthReturnState) {
      const verified = verifyOAuthOnboardingReturn(oauthReturnState)
      if (!verified.valid || verified.userId !== session.userId) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "INVALID_STATE",
              message: "Authorization expired. Reconnect from your coding agent.",
            },
          },
          { status: 400 }
        )
      }
    }

    const installUrl = getInstallAppUrl()
    const url = new URL(installUrl)
    // Signed, expiring, workspace-bound state (verified in the GET callback). (S2)
    url.searchParams.set(
      "state",
      createInstallState(workspaceId, returnTo, Date.now(), oauthReturnState)
    )

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.github.connect_started",
        resourceType: "integration",
      },
    })

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

export const POST = withCookieMutation(post)
