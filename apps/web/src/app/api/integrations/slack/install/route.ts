import { withCookieMutation } from "../../../../../lib/api-auth"
import { NextResponse, type NextRequest } from "next/server"
import { env } from "@lyrashield/config"
import { prisma, upsertConnectorConnection, ConnectorConnectionError } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  exchangeSlackOAuthCode,
  getSlackAuthorizeUrl,
  SLACK_CONNECT_SCOPES,
} from "@lyrashield/integrations"
import { uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { createInstallState, verifyInstallState } from "../../../../../lib/github-install-state"
import { z } from "zod"

/**
 * Slack OAuth connect flow for the read-only connector. Mirrors the GitHub
 * App install route: POST mints a signed workspace-bound state and returns
 * the provider authorize URL; GET (the OAuth callback) verifies state,
 * re-checks `integration:manage`, exchanges the code, seals the bot token
 * into encrypted evidence storage (only the storage reference is persisted),
 * and upserts the Integration row in place — so a reconnect preserves the
 * connection identity and its idempotent operation history.
 */

const InstallRequestSchema = z.object({
  workspaceId: z.string().min(1),
})

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
    if (base.protocol === "https:") base.protocol = "http:"
  }
  base.pathname = "/"
  base.search = ""
  base.hash = ""
  return base
}

function slackRedirectUri(request: NextRequest): string {
  return new URL("/api/integrations/slack/install", getAppOrigin(request)).toString()
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    const loginUrl = new URL("/sign-in", getAppOrigin(request))
    loginUrl.searchParams.set("callbackUrl", "/api/integrations/slack/install")
    return NextResponse.redirect(loginUrl)
  }

  const searchParams = request.nextUrl.searchParams
  const returnPath = "/dashboard/integrations"
  const providerError = searchParams.get("error")
  if (providerError) {
    const redirectUrl = new URL(returnPath, getAppOrigin(request))
    redirectUrl.searchParams.set("slack", "denied")
    return NextResponse.redirect(redirectUrl)
  }

  const code = searchParams.get("code")
  const state = searchParams.get("state")
  if (!code || !state) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "MISSING_PARAM", message: "code and state are required" },
      },
      { status: 400 }
    )
  }

  const stateResult = verifyInstallState(state)
  if (!stateResult.valid) {
    logger.warn("Slack connect callback rejected — invalid state", { reason: stateResult.reason })
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

    const exchange = await exchangeSlackOAuthCode(code, slackRedirectUri(request))
    if (!exchange.teamId) {
      throw new Error("Slack OAuth exchange returned no team id")
    }

    // Seal the bot token into the encrypted evidence vault; only the storage
    // reference reaches the Integration row, and reads stay workspace-bound.
    const sealed = await uploadEncryptedArtifact({
      workspaceId,
      ownerId: "integrations",
      namespace: "connectors",
      type: "slack-bot-token",
      content: JSON.stringify({ botToken: exchange.accessToken }),
    })

    const grantedScopes = exchange.scope
      ? exchange.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [...SLACK_CONNECT_SCOPES]

    const integration = await upsertConnectorConnection({
      workspaceId,
      provider: "slack",
      externalId: exchange.teamId,
      name: exchange.teamName ?? exchange.teamId,
      configRef: sealed.storageUri,
      capabilities: { scopes: grantedScopes },
      metadata: {
        teamId: exchange.teamId,
        teamName: exchange.teamName,
        botUserId: exchange.botUserId,
      },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: authSession.userId,
        action: "integration.slack.connected",
        resourceType: "integration",
        resourceId: integration.id,
      },
    })

    logger.info("Slack workspace connected", {
      workspaceId,
      teamId: exchange.teamId,
    })

    const redirectUrl = new URL(returnPath, getAppOrigin(request))
    redirectUrl.searchParams.set("connected", "slack")
    return NextResponse.redirect(redirectUrl)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof ConnectorConnectionError && error.code === "ALREADY_CLAIMED") {
      const redirectUrl = new URL(returnPath, getAppOrigin(request))
      redirectUrl.searchParams.set("slack", "already_claimed")
      return NextResponse.redirect(redirectUrl)
    }
    logger.error("Failed to complete Slack connect", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
    })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to connect Slack" },
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
        error: { code: "VALIDATION_ERROR", message: "workspaceId is required" },
      },
      { status: 400 }
    )
  }
  const { workspaceId } = parsed.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.integration.manage)
    const authorizeUrl = getSlackAuthorizeUrl(
      createInstallState(workspaceId, "integrations", Date.now()),
      slackRedirectUri(request)
    )

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.slack.connect_started",
        resourceType: "integration",
      },
    })

    return apiSuccess({ authorizeUrl })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to build Slack authorize URL", { error: String(error) })
    return apiError("CONFIG_ERROR", "Slack OAuth is not configured", 500)
  }
}

export const POST = withCookieMutation(post)
