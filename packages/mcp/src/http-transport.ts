import { createMcpHandler } from "@modelcontextprotocol/server"
import { createLyraShieldServer } from "./create-server"
import type { RemoteApprovalContext, RemoteApprovalGate } from "./create-server"
import type { ToolHandlerContext } from "./tools"

// Diffs and explicit source snapshots can be larger than attachment content.
// The upload tool enforces its own 64 KiB content ceiling after this transport cap.
const MAX_REMOTE_MCP_REQUEST_BYTES = 13 * 1024 * 1024

async function requestWithinLimit(request: Request): Promise<boolean> {
  if (request.method !== "POST") return true
  const length = request.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REMOTE_MCP_REQUEST_BYTES))
    return false
  const reader = request.clone().body?.getReader()
  if (!reader) return true
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return true
      total += value.byteLength
      if (total > MAX_REMOTE_MCP_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined)
        void request.body?.cancel().catch(() => undefined)
        return false
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Remote (Streamable HTTP) MCP handler for the LyraShield app.
 *
 * Runs the same security engine as the stdio server (prompt-injection guard +
 * per-tool JSON-Schema), but in **stateless** mode: a fresh SDK server and
 * transport per request, so it slots into a serverless/edge-adjacent route with
 * no cross-request session storage.
 *
 * Authentication and rate limiting are the CALLER's responsibility (the web
 * route verifies the workspace API key and injects it into `toolContext`).
 * This module stays free of any server-only dependency (@lyrashield/db,
 * prisma) so the package remains publishable and standalone.
 *
 * Approval posture: a stateless HTTP request has no channel for server→client
 * elicitation, so mutating tools are refused (approvalMode "deny") unless the
 * caller passes a `remoteApprovalGate` (remote out-of-band approval) or
 * `allowMutations` for a trusted, pre-authorized automation.
 */
export interface RemoteMcpOptions {
  /** Authenticated tool context (API base URL + the caller's workspace key). */
  toolContext: ToolHandlerContext
  /** Allow mutating tools without an interactive gate (trusted automation only). */
  allowMutations?: boolean
  /** Workspace context for the remote out-of-band approval gate. */
  remoteApprovalContext?: RemoteApprovalContext
  /** Remote out-of-band approval gate callback. */
  remoteApprovalGate?: RemoteApprovalGate
  /** Advertise the pre-authorized, idempotent mutation contract. */
  delegatedAuthorization?: boolean
}

export async function handleRemoteMcpRequest(
  request: Request,
  options: RemoteMcpOptions
): Promise<Response> {
  if (!(await requestWithinLimit(request))) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "MCP request body too large" }, id: null },
      { status: 413, headers: { "Cache-Control": "no-store" } }
    )
  }
  const approvalMode = options.remoteApprovalGate ? "remote-oob" : "deny"
  const handler = createMcpHandler(
    () =>
      createLyraShieldServer({
        toolContext: options.toolContext,
        approvalMode,
        ...(options.allowMutations ? { allowMutations: true } : {}),
        ...(options.delegatedAuthorization ? { delegatedAuthorization: true } : {}),
        ...(options.remoteApprovalContext && options.remoteApprovalGate
          ? {
              remoteApprovalContext: options.remoteApprovalContext,
              remoteApprovalGate: options.remoteApprovalGate,
            }
          : {}),
      }).server
  )
  const response = await handler.fetch(request)
  // Responses contain workspace-scoped security data. Prevent browser/CDN
  // caching and keep auth/protocol variants distinct even when an intermediary
  // ignores endpoint configuration.
  response.headers.set("Cache-Control", "no-store, no-transform")
  response.headers.set("Vary", "Accept, Authorization, MCP-Protocol-Version")
  return response
}
