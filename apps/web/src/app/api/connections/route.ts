import { withCookieMutation } from "../../../lib/api-auth"
import {
  CANONICAL_OPERATIONS,
  createAgentConnection,
  listAgentConnections,
  prisma,
  resolveOAuthClientDisplayName,
} from "@lyrashield/db"
import { auth, requireWorkspaceAccess } from "@lyrashield/auth/server"
import { requireBrowserConnectionManager } from "./connection-auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import {
  connectionGrantMatchesConsent,
  verifyOAuthConsentState,
} from "../../../lib/oauth-consent-state"
import { z } from "zod"
import { ScanModeSchema } from "@lyrashield/types"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requireWorkspaceAccess(workspaceId)
    const connections = await listAgentConnections(workspaceId)
    return apiSuccess(connections)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list agent connections", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list agent connections", 500)
  }
}

const CreateConnectionSchema = z.object({
  workspaceId: z.string().min(1),
  clientType: z.string().trim().min(1).max(100),
  clientName: z.string().trim().max(100).optional(),
  oauthClientId: z.string().trim().min(1).max(255),
  scopes: z.array(z.enum(["lyrashield.read", "lyrashield.write"])).min(1),
  allowedOperations: z.array(z.nativeEnum(CANONICAL_OPERATIONS)).default([]),
  allowedTargetIds: z.array(z.string().min(1).max(128)).max(100).default([]),
  allTargets: z.boolean().default(false),
  allowedProfiles: z.array(ScanModeSchema).max(5).default([]),
  expiresAt: z.string().datetime().optional(),
  consentState: z.string().min(1).max(2048),
})

async function post(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = CreateConnectionSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const {
      workspaceId,
      oauthClientId,
      scopes,
      allowedOperations,
      allowedTargetIds,
      allTargets,
      allowedProfiles,
      expiresAt,
      consentState,
    } = parsed.data

    const { session } = await requireBrowserConnectionManager(workspaceId)

    // The grant must describe the same client and no more scope than the
    // server-rendered authorization request the user is consenting to. The
    // consent page mints the signed state; a forged or stale one fails here
    // before any connection is persisted.
    const consent = verifyOAuthConsentState(consentState)
    if (!consent.valid) {
      return apiError(
        "VALIDATION_ERROR",
        "The connection request could not be verified. Reload the consent page and try again.",
        400
      )
    }
    if (consent.payload.userId !== session.userId) {
      return apiError(
        "VALIDATION_ERROR",
        "The connection request was issued for a different session.",
        403
      )
    }
    if (
      !connectionGrantMatchesConsent(consent.payload, {
        oauthClientId,
        scopes,
      })
    ) {
      return apiError(
        "VALIDATION_ERROR",
        "The requested connection does not match the authorization request being consented to.",
        400
      )
    }

    const oauthClient = await prisma.oauthClient.findUnique({
      where: { clientId: oauthClientId },
      select: { name: true, uri: true, softwareId: true, redirectUris: true },
    })
    if (!oauthClient) {
      return apiError("VALIDATION_ERROR", "The OAuth client is no longer registered.", 400)
    }
    const trustedClientName = resolveOAuthClientDisplayName(oauthClient)

    const automating = scopes.includes("lyrashield.write")
    if (automating && allowedOperations.length === 0) {
      return apiError("VALIDATION_ERROR", "Select at least one workflow to automate", 400)
    }
    if (automating && !allTargets && allowedTargetIds.length === 0) {
      return apiError("VALIDATION_ERROR", "Select at least one target or all targets", 400)
    }
    if (allTargets && allowedTargetIds.length > 0) {
      return apiError("VALIDATION_ERROR", "Choose all targets or selected targets, not both", 400)
    }
    if (new Set(allowedTargetIds).size !== allowedTargetIds.length) {
      return apiError("VALIDATION_ERROR", "Target selection contains duplicates", 400)
    }
    const billableOperationSelected = allowedOperations.some(
      (operation) =>
        operation === CANONICAL_OPERATIONS.SCAN_CREATE ||
        operation === CANONICAL_OPERATIONS.RETEST_CREATE
    )
    if (automating && billableOperationSelected && allowedProfiles.length === 0) {
      return apiError("VALIDATION_ERROR", "Select at least one scan profile", 400)
    }
    if (
      !automating &&
      (allowedOperations.length > 0 ||
        allowedTargetIds.length > 0 ||
        allTargets ||
        allowedProfiles.length > 0)
    ) {
      return apiError(
        "VALIDATION_ERROR",
        "Read-only connections cannot grant automation scope",
        400
      )
    }
    if (allowedTargetIds.length > 0) {
      const matchingTargets = await prisma.target.count({
        where: { workspaceId, id: { in: allowedTargetIds }, deletedAt: null },
      })
      if (matchingTargets !== allowedTargetIds.length) {
        return apiError("VALIDATION_ERROR", "One or more selected targets are unavailable", 400)
      }
    }

    const connection = await createAgentConnection({
      workspaceId,
      userId: session.userId,
      clientType: trustedClientName,
      clientName: trustedClientName,
      oauthClientId,
      scopes,
      allowedOperations,
      allowedTargetIds,
      allTargets,
      allowedProfiles,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "agent_connection.created",
        resourceType: "agent_connection",
        resourceId: connection.id,
        metadata: {
          clientType: trustedClientName,
          clientName: trustedClientName,
          allowedOperations,
          allowedTargetIds,
          allowedProfiles,
        },
      },
    })

    await auth.api.updateSession({
      headers: request.headers,
      body: { activeWorkspaceId: workspaceId, pendingAgentConnectionId: connection.id },
    })

    return apiSuccess(connection, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create agent connection", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create agent connection", 500)
  }
}

export const POST = withCookieMutation(post)
