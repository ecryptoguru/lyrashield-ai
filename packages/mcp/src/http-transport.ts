import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { createLyraShieldServer } from "./create-server"
import type { RemoteApprovalContext, RemoteApprovalGate } from "./create-server"
import type { ToolHandlerContext } from "./tools"

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
}

export async function handleRemoteMcpRequest(
  request: Request,
  options: RemoteMcpOptions
): Promise<Response> {
  const approvalMode = options.remoteApprovalGate ? "remote-oob" : "deny"
  const { server } = createLyraShieldServer({
    toolContext: options.toolContext,
    approvalMode,
    ...(options.allowMutations ? { allowMutations: true } : {}),
    ...(options.remoteApprovalContext && options.remoteApprovalGate
      ? {
          remoteApprovalContext: options.remoteApprovalContext,
          remoteApprovalGate: options.remoteApprovalGate,
        }
      : {}),
  })

  // Stateless: no sessionIdGenerator. Each request is fully self-contained.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  await server.connect(transport)

  // Release the per-request server/transport pair once the response stream has
  // been fully delivered. Closing eagerly here would truncate the (possibly
  // streamed / SSE) response body, so tie cleanup to transport close instead.
  transport.onclose = () => {
    void server.close().catch(() => {})
  }

  return transport.handleRequest(request)
}
