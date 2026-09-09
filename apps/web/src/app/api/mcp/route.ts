import { verifyApiKey } from "@lyrashield/db"
import { handleRemoteMcpRequest } from "@lyrashield/mcp"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { makeRemoteApprovalGate } from "./remote-approval-gate"
import { verifyOAuthBearer } from "@lyrashield/auth/server"

/**
 * Remote LyraShield MCP endpoint (Streamable HTTP) at /api/mcp.
 *
 * This is how cloud coding platforms that can't run a local stdio server
 * (Lovable, Bolt.new, Replit, v0, …) reach LyraShield. Authentication is a
 * workspace API key as a Bearer token — the same `lsk_` key used by the stdio
 * server — or an OAuth access token for the hosted MCP resource. The tools
 * re-call the REST API with the same bearer, so workspace and scope enforcement
 * apply uniformly.
 *
 * API keys use their existing REST write authorization. OAuth mutations use
 * the connection grant and idempotency ledger; legacy OAuth retains its old
 * approval contract until the user reconnects.
 *
 * Rate limiting is applied by the shared /api/* middleware bucket.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function unauthorized(): Response {
  // WWW-Authenticate advertises Bearer so MCP clients know how to authenticate.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized: valid LyraShield API key or OAuth bearer required",
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="LyraShield MCP", resource_metadata="${new URL("/.well-known/oauth-protected-resource", env.NEXT_PUBLIC_APP_URL).toString()}"`,
      },
    }
  )
}

export interface RemoteAuthInfo {
  workspaceId: string
  scopes: string[]
  createdById: string
  keyId: string
  prefix: string
  kind: "api-key" | "oauth"
  connection?: {
    id: string
    workspaceId: string
    status: "ACTIVE"
    authorizationVersion: number
    allowedOperations: string[]
    allowedTargetIds: string[]
    allTargets: boolean
    allowedProfiles: string[]
    expiresAt: Date | null
  }
}

async function authenticate(request: Request): Promise<RemoteAuthInfo | null> {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const rawToken = header.slice("Bearer ".length).trim()
  if (!rawToken) return null

  if (rawToken.startsWith("lsk_")) {
    const apiKey = await verifyApiKey(rawToken)
    return apiKey ? { ...apiKey, kind: "api-key" } : null
  }

  const oauth = await verifyOAuthBearer(rawToken)
  if (!oauth) return null
  return {
    workspaceId: oauth.workspaceId,
    scopes: oauth.scopes,
    createdById: oauth.userId,
    keyId: `oauth:${oauth.clientId ?? "client"}`,
    prefix: "oauth",
    kind: "oauth",
    connection: oauth.connectionId
      ? {
          id: oauth.connectionId,
          workspaceId: oauth.workspaceId,
          status: "ACTIVE" as const,
          authorizationVersion: oauth.authorizationVersion ?? 1,
          allowedOperations: oauth.allowedOperations ?? [],
          allowedTargetIds: oauth.allowedTargetIds ?? [],
          allTargets: oauth.allTargets ?? false,
          allowedProfiles: oauth.allowedProfiles ?? [],
          expiresAt: oauth.expiresAt ?? null,
        }
      : undefined,
  }
}

async function handle(request: Request): Promise<Response> {
  try {
    const authInfo = await authenticate(request)
    if (!authInfo) return unauthorized()

    const toolContext = {
      apiBaseUrl: env.NEXT_PUBLIC_APP_URL,
      apiKey: request.headers.get("authorization")!.slice("Bearer ".length).trim(),
      allowAutoDetect: false,
    }

    return await handleRemoteMcpRequest(request, {
      toolContext,
      // Ruling 2 (item 1.3): one authorization model. API keys no longer
      // execute mutations directly and no longer enter the legacy approval
      // queue — the gate returns the structured connect-over-OAuth response
      // for them. OAuth connections execute within their grant.
      allowMutations: false,
      delegatedAuthorization: authInfo.kind === "oauth" && !!authInfo.connection,
      remoteApprovalContext: {
        workspaceId: authInfo.workspaceId,
        scopes: authInfo.scopes,
        apiKeyInfo: { keyId: authInfo.keyId, createdById: authInfo.createdById },
      },
      remoteApprovalGate: makeRemoteApprovalGate({
        apiKeyInfo: authInfo,
        connection: authInfo.connection,
        toolContext,
      }),
    })
  } catch (err) {
    logger.error("Remote MCP request failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

export const POST = handle
export const GET = handle
export const DELETE = handle
