import { createReadStream } from "node:fs"
import { createInterface as createPrompt } from "node:readline/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpServer } from "./server"
import type { ApprovalGate, McpServerOptions } from "./server"
import { logger } from "@lyrashield/logger"

export const SERVER_NAME = "lyrashield-mcp"
export const SERVER_VERSION = "0.2.0"

export interface CreateServerOptions {
  /** When true, mutating tools skip the approval gate (trusted CI). */
  allowMutations?: boolean
  /** Override the engine's tool context (API base URL / key / fetch). */
  toolContext?: McpServerOptions["toolContext"]
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

  const approvalGate: ApprovalGate = async (toolName) => {
    const elicited = await elicitApproval(toolName)
    if (elicited) return elicited
    return ttyApproval(toolName)
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
