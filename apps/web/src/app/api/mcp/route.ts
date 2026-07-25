import { verifyApiKey } from "@lyrashield/db"
import { handleRemoteMcpRequest } from "@lyrashield/mcp"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

/**
 * Remote LyraShield MCP endpoint (Streamable HTTP) at /api/mcp.
 *
 * This is how cloud coding platforms that can't run a local stdio server
 * (Lovable, Bolt.new, Replit, v0, …) reach LyraShield. Authentication is the
 * workspace API key as a Bearer token — the same `lsk_` key used by the stdio
 * server; the tools re-call the REST API with it, so the I1 workspace-binding
 * and read/write scope enforcement apply uniformly.
 *
 * Mutating tools are refused here (no interactive approval channel over a
 * stateless HTTP request). A trusted automation can opt in process-wide via
 * LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true — off by default. Each remote
 * request is still bounded to its own workspace API key and its own write scope.
 * Interactive mutations belong on the local stdio server, which prompts the human.
 *
 * Rate limiting is applied by the shared /api/* middleware bucket.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ALLOW_REMOTE_MUTATIONS = process.env.LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS === "true"

function unauthorized(): Response {
  // WWW-Authenticate advertises Bearer so MCP clients know how to authenticate.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: valid LyraShield API key required" },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="LyraShield MCP"',
      },
    }
  )
}

async function authenticate(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const rawKey = header.slice("Bearer ".length).trim()
  const verified = await verifyApiKey(rawKey)
  if (!verified) return null
  return rawKey
}

async function handle(request: Request): Promise<Response> {
  const rawKey = await authenticate(request)
  if (!rawKey) return unauthorized()

  try {
    return await handleRemoteMcpRequest(request, {
      toolContext: {
        apiBaseUrl: env.NEXT_PUBLIC_APP_URL,
        apiKey: rawKey,
      },
      allowMutations: ALLOW_REMOTE_MUTATIONS,
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
