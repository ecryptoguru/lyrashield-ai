import { verifyApiKey } from "@lyrashield/db"
import { handleRemoteMcpRequest, MCP_TASK_PROTOCOL_VERSION } from "@lyrashield/mcp"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { makeRemoteApprovalGate } from "./remote-approval-gate"
import { makeHostedMcpTaskBackend } from "@/lib/mcp-tasks"
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
 * Remote mutations execute only through a connected OAuth client's delegated
 * grant and idempotency ledger. A caller without a connection — an API key or
 * a legacy OAuth bearer — receives one structured `connect_required` response
 * pointing at OAuth connect; nothing executes and nothing is queued.
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

/**
 * The negotiated MCP protocol version for this request: the
 * MCP-Protocol-Version header on post-initialize calls, or the
 * protocolVersion inside an initialize body (the transport negotiates from
 * it). Tasks are only offered on 2025-11-25+ — every older client keeps the
 * immediate tools/call semantics.
 */
function negotiatedProtocolVersion(header: string | null, body: string): string | undefined {
  if (header) return header
  try {
    const message: unknown = JSON.parse(body)
    const init = Array.isArray(message)
      ? message.find((m) => m?.method === "initialize")
      : (message as { method?: string })?.method === "initialize"
        ? message
        : undefined
    const version = (init as { params?: { protocolVersion?: unknown } } | undefined)?.params
      ?.protocolVersion
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
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

    // Read the body once so the initialize params can drive the protocol gate;
    // the transport receives a re-materialized request carrying the same body.
    let mcpRequest = request
    let bodyText = ""
    if (request.method === "POST") {
      bodyText = await request.text()
      mcpRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      })
    }
    const protocolVersion = negotiatedProtocolVersion(
      request.headers.get("mcp-protocol-version"),
      bodyText
    )

    // Tasks are only advertised where they are honest: a task-semantics
    // protocol AND a delegated OAuth connection — the binding is
    // connection-principal-scoped, so API-key/legacy bearers never see them.
    const tasksEnabled =
      protocolVersion !== undefined &&
      protocolVersion >= MCP_TASK_PROTOCOL_VERSION &&
      authInfo.kind === "oauth" &&
      authInfo.connection !== undefined

    return await handleRemoteMcpRequest(mcpRequest, {
      toolContext,
      // Remote mutations run only inside a connected OAuth client's delegated
      // grant. Every other credential is gated to a single connect_required
      // response — the retired approval queue is no longer reachable here.
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
      ...(tasksEnabled && authInfo.connection
        ? {
            tasks: {
              backend: makeHostedMcpTaskBackend({
                workspaceId: authInfo.workspaceId,
                connection: authInfo.connection,
              }),
            },
          }
        : {}),
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
