import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import {
  auth,
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

    return {
      userId,
      workspaceId,
      scopes,
      clientId: typeof payload.azp === "string" ? payload.azp : undefined,
      sessionId: typeof payload.sid === "string" ? `oauth:${payload.sid}` : undefined,
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
      const activeWorkspaceId = (session?.session as { activeWorkspaceId?: unknown } | undefined)
        ?.activeWorkspaceId
      const workspaceId = typeof activeWorkspaceId === "string" ? activeWorkspaceId : undefined
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
