import { createReadStream } from "node:fs"
import { createInterface as createPrompt } from "node:readline/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpServer } from "./server"
import type { ApprovalDecision, ApprovalGate, McpServerOptions } from "./server"
import { logger } from "@lyrashield/logger"

export const SERVER_NAME = "lyrashield-mcp"
export const SERVER_VERSION = "0.2.0"

export interface RemoteApprovalContext {
  workspaceId: string
  scopes: string[]
  apiKeyInfo: { keyId: string; createdById: string }
}

export type RemoteApprovalGate = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: RemoteApprovalContext
) => Promise<ApprovalDecision> | ApprovalDecision

export interface CreateServerOptions {
  /** When true, mutating tools skip the approval gate (trusted CI). */
  allowMutations?: boolean
  /** Override the engine's tool context (API base URL / key / fetch). */
  toolContext?: McpServerOptions["toolContext"]
  /**
   * How mutating tools obtain human approval:
   * - "interactive" (default): elicitation → controlling-TTY → fail-closed.
   *   Right for the local stdio server, where a human is present.
   * - "deny": no approval channel exists (e.g. the stateless remote HTTP
   *   endpoint, where server→client elicitation can't round-trip). Mutating
   *   tools are refused with a clear reason unless allowMutations is set.
   * - "remote-oob": create an AgentApproval row and return a structured PENDING
   *   result; a later call with `approvalId` resumes after human approval.
   */
  approvalMode?: "interactive" | "deny" | "remote-oob"
  /** Gate callback for "remote-oob" mode. Receives the authenticated workspace context. */
  remoteApprovalGate?: RemoteApprovalGate
  /** Authenticated context for the remote approval gate. */
  remoteApprovalContext?: RemoteApprovalContext
}

/**
 * Build a LyraShield MCP {@link Server} on the official SDK, wired to our
 * security engine ({@link McpServer}) which enforces the prompt-injection guard
 * and the human-approval gate and owns the authoritative per-tool JSON-Schema.
 *
 * The approval gate prefers MCP elicitation (works inside IDEs), then a
 * controlling TTY, then fails closed. Read-only tools are never gated.
 */
export function createLyraShieldServer(options: CreateServerOptions = {}): {
  server: Server
  engine: McpServer
} {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  )

  async function elicitApproval(
    toolName: string
  ): Promise<{ approved: boolean; reason?: string } | null> {
    const caps = server.getClientCapabilities()
    if (!caps?.elicitation) return null
    try {
      const result = await server.elicitInput({
        message: `LyraShield wants to run the mutating tool "${toolName}". Approve this action?`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: `Allow "${toolName}" to run with the provided arguments.`,
            },
          },
          required: ["approve"],
        },
      })
      if (result.action !== "accept") {
        return { approved: false, reason: `Elicitation ${result.action}` }
      }
      const approve = (result.content as { approve?: unknown } | undefined)?.approve === true
      return { approved: approve, reason: approve ? "approved via elicitation" : "declined" }
    } catch (err) {
      logger.warn("MCP elicitation failed; falling back to TTY", {
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  async function ttyApproval(toolName: string): Promise<{ approved: boolean; reason?: string }> {
    // Only attempt an interactive prompt when a controlling terminal actually
    // exists. An MCP server launched by an IDE (or a CI job) has no TTY —
    // attempting to read /dev/tty there would hang, so we fail closed instead.
    if (!process.stdin.isTTY && !process.stderr.isTTY) {
      return { approved: false, reason: "No interactive terminal available for approval" }
    }
    try {
      const input = createReadStream("/dev/tty")
      const prompt = createPrompt({ input, output: process.stderr })
      const answer = await prompt.question(`Approve LyraShield MCP mutation "${toolName}"? [y/N] `)
      prompt.close()
      input.close()
      return {
        approved: answer.trim().toLowerCase() === "y",
        reason: "interactive terminal approval",
      }
    } catch {
      return { approved: false, reason: "No interactive terminal available for approval" }
    }
  }

  const denyGate: ApprovalGate = () => ({
    approved: false,
    reason:
      "This LyraShield endpoint has no interactive approval channel. Run the mutating tool from the local stdio MCP server (which prompts for approval), or use a trusted automation configured with allowMutations.",
  })

  const interactiveGate: ApprovalGate = async (toolName) => {
    const elicited = await elicitApproval(toolName)
    if (elicited) return elicited
    return ttyApproval(toolName)
  }

  let approvalGate: ApprovalGate | undefined
  if (options.allowMutations) {
    approvalGate = undefined
  } else if (options.approvalMode === "deny") {
    approvalGate = denyGate
  } else if (
    options.approvalMode === "remote-oob" &&
    options.remoteApprovalGate &&
    options.remoteApprovalContext
  ) {
    const remote = options.remoteApprovalGate
    const ctx = options.remoteApprovalContext
    approvalGate = (toolName, args) => remote(toolName, args, ctx)
  } else {
    approvalGate = interactiveGate
  }

  const engine = new McpServer({
    ...(options.allowMutations ? { allowMutations: true } : { approvalGate }),
    ...(options.toolContext ? { toolContext: options.toolContext } : {}),
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: engine.listTools(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const result = await engine.callTool(name, (args ?? {}) as Record<string, unknown>)
    return {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    }
  })

  return { server, engine }
}
