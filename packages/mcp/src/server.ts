import { logger } from "@lyrashield/logger"
import { ALL_TOOLS, type McpTool, type McpToolResult } from "./tools"
import { PromptInjectionGuard } from "./prompt-injection-guard"

export interface McpServerOptions {
  serverName?: string
  serverVersion?: string
  strictMode?: boolean
}

export class McpServer {
  private tools: Map<string, McpTool>
  private guard: PromptInjectionGuard
  private serverName: string
  private serverVersion: string

  constructor(options?: McpServerOptions) {
    this.tools = new Map(ALL_TOOLS.map((t) => [t.name, t]))
    this.guard = new PromptInjectionGuard({
      strictMode: options?.strictMode ?? true,
    })
    this.serverName = options?.serverName ?? "lyrashield-mcp"
    this.serverVersion = options?.serverVersion ?? "0.1.0"
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
      })
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Tool call blocked by security guard",
            reason: guardResult.reason,
            detectedPatterns: guardResult.detectedPatterns,
          }),
        }],
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

    try {
      return await tool.handler(safeArgs)
    } catch (err) {
      logger.error("MCP tool call failed", {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Tool execution failed",
            message: err instanceof Error ? err.message : "Unknown error",
          }),
        }],
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
