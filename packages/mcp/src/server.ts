import { logger } from "@lyrashield/logger"
import {
  createAllTools,
  MCP_TOOL_ANNOTATIONS,
  type McpTool,
  type McpToolResult,
  type ToolHandlerContext,
} from "./tools"
import { PromptInjectionGuard } from "./prompt-injection-guard"

/**
 * Human-approval gate for mutating MCP tools. Returns whether the mutating call
 * may proceed. Invoked AT EXECUTION time (after the injection guard, before the
 * handler) so approval is re-validated against the exact arguments — no TOCTOU
 * gap between listing/approval and execution. (S8)
 *
 * Wire this to the product's Agent Action Layer / a human confirmation prompt.
 * If omitted, the server is fail-closed: mutating tools are blocked.
 */
export interface ApprovalDecision {
  approved: boolean
  /** When true, the call is held for out-of-band human approval rather than denied. */
  pending?: boolean
  approvalId?: string
  approvalUrl?: string
  reason?: string
  /** Pre-computed tool result; if set and approved is true, the handler is skipped. */
  result?: McpToolResult
}

export type ApprovalGate = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<ApprovalDecision> | ApprovalDecision

export interface McpServerOptions {
  serverName?: string
  serverVersion?: string
  strictMode?: boolean
  toolContext?: ToolHandlerContext
  /**
   * Approval gate for mutating tools. Omit to fail-closed (mutations blocked).
   * Pass `allowMutations: true` explicitly to opt out (e.g. trusted CI contexts).
   */
  approvalGate?: ApprovalGate
  /** Explicit opt-out of the mutation gate. Defaults to false (gate enforced). */
  allowMutations?: boolean
}

export class McpServer {
  private tools: Map<string, McpTool>
  private guard: PromptInjectionGuard
  private serverName: string
  private serverVersion: string
  private approvalGate?: ApprovalGate
  private allowMutations: boolean

  constructor(options?: McpServerOptions) {
    const context: ToolHandlerContext = options?.toolContext ?? {
      apiBaseUrl: process.env.LYRASHIELD_API_URL ?? "http://localhost:3000",
      apiKey: process.env.LYRASHIELD_API_KEY ?? "",
    }
    this.tools = new Map(createAllTools(context).map((t) => [t.name, t]))
    this.guard = new PromptInjectionGuard({
      strictMode: options?.strictMode ?? true,
    })
    this.serverName = options?.serverName ?? "lyrashield-mcp"
    this.serverVersion = options?.serverVersion ?? "0.1.0"
    this.approvalGate = options?.approvalGate
    this.allowMutations = options?.allowMutations ?? false
  }

  listTools() {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      title: (t.annotations ?? MCP_TOOL_ANNOTATIONS[t.name])?.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations ?? MCP_TOOL_ANNOTATIONS[t.name],
      outputSchema: t.outputSchema ?? { type: "object", additionalProperties: true },
      // SDK 1.30 supports MCP task declarations, but LyraShield scan IDs are
      // persisted domain jobs. Advertising protocol tasks without a durable
      // MCP task store would make stateless HTTP cancellation and replay unsafe.
      execution: { taskSupport: "forbidden" as const },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      logger.warn("MCP tool call — unknown tool", { tool: name })
      const error = { error: `Unknown tool: ${name}` }
      return {
        content: [{ type: "text", text: JSON.stringify(error) }],
        isError: true,
        structuredContent: error,
      }
    }

    const guardResult = this.guard.checkToolCall(name, args)
    if (!guardResult.allowed) {
      logger.warn("MCP tool call blocked by prompt injection guard", {
        tool: name,
        reason: guardResult.reason,
        detectedPatterns: guardResult.detectedPatterns,
        args,
      })
      const error = {
        error: "Tool call blocked by security guard",
        reason: guardResult.reason,
        detectedPatterns: guardResult.detectedPatterns,
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(error),
          },
        ],
        isError: true,
        structuredContent: error,
      }
    }

    let safeArgs = args
    if (guardResult.sanitizedInput) {
      try {
        const parsed = JSON.parse(guardResult.sanitizedInput)
        safeArgs = parsed.args ?? args
      } catch {
        logger.warn("MCP sanitization produced invalid JSON, using original args", { tool: name })
      }
    }

    // Human-approval gate for mutating tools, evaluated against the exact
    // (sanitized) args right before execution — no TOCTOU window. Read-only
    // tools skip this. Fail-closed: with no gate and no explicit opt-in, a
    // mutating call is blocked rather than silently executed. (S8)
    if (tool.mutating && !this.allowMutations) {
      const decision = this.approvalGate
        ? await this.approvalGate(name, safeArgs)
        : {
            approved: false,
            reason: "No approval gate configured; mutating tools are blocked by default.",
          }
      if (!decision.approved) {
        if (decision.pending) {
          logger.info("MCP mutating tool pending human approval", {
            tool: name,
            approvalId: decision.approvalId,
          })
          const pending = {
            status: "PENDING",
            approvalId: decision.approvalId,
            approvalUrl: decision.approvalUrl,
            message:
              decision.reason ??
              "This action requires human approval. Poll with the same arguments and approvalId once approved.",
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(pending),
              },
            ],
            structuredContent: pending,
          }
        }
        logger.warn("MCP mutating tool blocked — not approved", {
          tool: name,
          reason: decision.reason,
        })
        const error = {
          error: "Mutating tool requires human approval",
          tool: name,
          reason: decision.reason ?? "Approval denied",
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(error),
            },
          ],
          isError: true,
          structuredContent: error,
        }
      }
      if (decision.result) {
        logger.info("MCP mutating tool returned pre-computed approved result", { tool: name })
        return decision.result
      }
      logger.info("MCP mutating tool approved", { tool: name })
    }

    logger.info("MCP tool call allowed", {
      tool: name,
      suspiciousPatterns:
        guardResult.detectedPatterns.length > 0 ? guardResult.detectedPatterns : undefined,
    })

    try {
      return await tool.handler(safeArgs)
    } catch (err) {
      logger.error("MCP tool call failed", {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      })
      const error = {
        error: "Tool execution failed",
        message: err instanceof Error ? err.message : "Unknown error",
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(error),
          },
        ],
        isError: true,
        structuredContent: error,
      }
    }
  }

  getServerInfo() {
    return {
      name: this.serverName,
      version: this.serverVersion,
      tools: this.listTools(),
    }
  }
}
