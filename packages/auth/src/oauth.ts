import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { withWorkspaceRLS } from "@lyrashield/db"
import {
  auth,
  OAUTH_AUTH_VERSION_CLAIM,
  OAUTH_CONNECTION_CLAIM,
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
  OAUTH_WORKSPACE_CLAIM,
} from "./auth"

export interface OAuthBearerContext {
  userId: string
  workspaceId: string
  scopes: string[]
  clientId?: string
  sessionId?: string
  connectionId?: string
  authorizationVersion?: number
  expiresAt?: Date | null
  allowedOperations?: string[]
  allowedTargetIds?: string[]
  allTargets?: boolean
  allowedProfiles?: string[]
}

const resourceClient = oauthProviderResourceClient(auth)
const { verifyBearerToken } = resourceClient.getActions()

type OAuthJwtPayload = Record<string, unknown> & {
  sub?: string
  scope?: string
  azp?: string
  sid?: string
}

function stringClaim(payload: OAuthJwtPayload, name: string): string | undefined {
  const value = payload[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Verify an OAuth access token issued for the hosted MCP resource. */
export async function verifyOAuthBearer(token: string): Promise<OAuthBearerContext | null> {
  try {
    const payload = await verifyBearerToken(token, {
      verifyOptions: { issuer: OAUTH_ISSUER, audience: OAUTH_RESOURCE },
      jwksUrl: `${OAUTH_ISSUER}/jwks`,
    })
    const userId = payload.sub
    const workspaceId = stringClaim(payload, OAUTH_WORKSPACE_CLAIM)
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : []
    if (!userId || !workspaceId) return null
    if (!scopes.includes(OAUTH_SCOPE_READ) && !scopes.includes(OAUTH_SCOPE_WRITE)) return null

    const connectionId = stringClaim(payload, OAUTH_CONNECTION_CLAIM)
    const rawAuthVersion = payload[OAUTH_AUTH_VERSION_CLAIM]
    const authVersion =
      typeof rawAuthVersion === "number"
        ? rawAuthVersion
        : typeof rawAuthVersion === "string" && /^[1-9]\d*$/.test(rawAuthVersion)
          ? Number(rawAuthVersion)
          : undefined

    let connectionInfo: {
      connectionId?: string
      authorizationVersion?: number
      expiresAt?: Date | null
      allowedOperations?: string[]
      allowedTargetIds?: string[]
      allTargets?: boolean
      allowedProfiles?: string[]
    } = {}

    if (connectionId) {
      if (authVersion === undefined || !Number.isSafeInteger(authVersion) || authVersion < 1)
        return null
      const conn = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.agentConnection.findUnique({
          where: { id: connectionId },
          select: {
            id: true,
            workspaceId: true,
            userId: true,
            status: true,
            authorizationVersion: true,
            allowedOperations: true,
            allowedTargetIds: true,
            allTargets: true,
            scopes: true,
            allowedProfiles: true,
            expiresAt: true,
            oauthClientId: true,
          },
        })
      )
      if (
        !conn ||
        conn.status !== "ACTIVE" ||
        conn.workspaceId !== workspaceId ||
        conn.userId !== userId
      ) {
        return null
      }
      if (conn.oauthClientId && conn.oauthClientId !== payload.azp) return null
      if (
        scopes
          .filter((scope) => scope === OAUTH_SCOPE_READ || scope === OAUTH_SCOPE_WRITE)
          .some((scope) => !conn.scopes.includes(scope))
      ) {
        return null
      }
      if (conn.expiresAt && conn.expiresAt.getTime() <= Date.now()) {
        return null
      }
      if (conn.authorizationVersion !== authVersion) {
        return null
      }
      connectionInfo = {
        connectionId: conn.id,
        authorizationVersion: conn.authorizationVersion,
        expiresAt: conn.expiresAt,
        allowedOperations: conn.allowedOperations,
        allowedTargetIds: conn.allowedTargetIds,
        allTargets: conn.allTargets,
        allowedProfiles: conn.allowedProfiles,
      }
    }

    return {
      userId,
      workspaceId,
      scopes,
      clientId: typeof payload.azp === "string" ? payload.azp : undefined,
      sessionId: typeof payload.sid === "string" ? `oauth:${payload.sid}` : undefined,
      ...connectionInfo,
    }
  } catch {
    // Device authorization returns a Better Auth session token rather than a
    // JWT. The bearer plugin validates it against the session store; device
    // connections intentionally receive read scope only until a full OAuth
    // consent flow grants an explicit write scope.
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })
      const workspaceId =
        session && typeof session.session.activeWorkspaceId === "string"
          ? session.session.activeWorkspaceId
          : undefined
      if (!session || !workspaceId) return null
      return {
        userId: session.user.id,
        workspaceId,
        scopes: [OAUTH_SCOPE_READ],
        sessionId: `device:${session.session.id}`,
      }
    } catch {
      return null
    }
  }
}
