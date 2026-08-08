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
 * Mutating tools use the remote out-of-band approval gate. A trusted API-key
 * automation can still opt in process-wide via
 * LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true; OAuth clients never bypass it.
 *
 * Rate limiting is applied by the shared /api/* middleware bucket.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ALLOW_REMOTE_MUTATIONS = env.LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS === "true"

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
  }
}

async function handle(request: Request): Promise<Response> {
  const authInfo = await authenticate(request)
  if (!authInfo) return unauthorized()

  try {
    const toolContext = {
      apiBaseUrl: env.NEXT_PUBLIC_APP_URL,
      apiKey: request.headers.get("authorization")!.slice("Bearer ".length).trim(),
    }

    return await handleRemoteMcpRequest(request, {
      toolContext,
      // Only the explicit API-key automation path may bypass OOB approval.
      allowMutations: ALLOW_REMOTE_MUTATIONS && authInfo.kind === "api-key",
      remoteApprovalContext: {
        workspaceId: authInfo.workspaceId,
        scopes: authInfo.scopes,
        apiKeyInfo: { keyId: authInfo.keyId, createdById: authInfo.createdById },
      },
      remoteApprovalGate: makeRemoteApprovalGate({ apiKeyInfo: authInfo, toolContext }),
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
