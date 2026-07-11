import { logger } from "@lyrashield/logger"
import { createAllTools, type McpTool, type McpToolResult, type ToolHandlerContext } from "./tools"
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
export type ApprovalGate = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<{ approved: boolean; reason?: string }> | { approved: boolean; reason?: string }

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
      apiKey: process.env.LYRASHIELD_API_KEY,
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
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      logger.warn("MCP tool call — unknown tool", { tool: name })
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Tool call blocked by security guard",
              reason: guardResult.reason,
              detectedPatterns: guardResult.detectedPatterns,
            }),
          },
        ],
        isError: true,
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
        logger.warn("MCP mutating tool blocked — not approved", {
          tool: name,
          reason: decision.reason,
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Mutating tool requires human approval",
                tool: name,
                reason: decision.reason ?? "Approval denied",
              }),
            },
          ],
          isError: true,
        }
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Tool execution failed",
              message: err instanceof Error ? err.message : "Unknown error",
            }),
          },
        ],
        isError: true,
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
