import { logger } from "@lyrashield/logger"
import {
  createAllTools,
  MCP_TOOL_ANNOTATIONS,
  type McpTool,
  type McpToolResult,
  type ToolHandlerContext,
} from "./tools"
import { PromptInjectionGuard } from "./prompt-injection-guard"
import { validateToolArgs } from "./args-validation"
import { capToolResult } from "./result-cap"
import { TASK_CAPABLE_TOOLS } from "./task-adapter"

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
  /**
   * Structured denial payload (for example a `connect_required` response that
   * directs the caller at OAuth connect). Surfaced to the client as
   * structuredContent plus an identical text body.
   */
  structuredContent?: Record<string, unknown>
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
  /**
   * Advertise `execution.taskSupport: "optional"` on task-capable tools. Set
   * only when the transport is wired with a task backend — otherwise every
   * tool stays "forbidden".
   */
  taskSupportEnabled?: boolean
}

export class McpServer {
  private tools: Map<string, McpTool>
  private guard: PromptInjectionGuard
  private serverName: string
  private serverVersion: string
  private approvalGate?: ApprovalGate
  private allowMutations: boolean
  private taskSupportEnabled: boolean

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
    this.taskSupportEnabled = options?.taskSupportEnabled ?? false
  }

  listTools({
    includeApprovalId = false,
    requireIdempotencyKey = false,
  }: { includeApprovalId?: boolean; requireIdempotencyKey?: boolean } = {}) {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      title: (t.annotations ?? MCP_TOOL_ANNOTATIONS[t.name])?.title,
      description: t.description,
      inputSchema: t.mutating
        ? {
            ...t.inputSchema,
            properties: {
              ...t.inputSchema.properties,
              idempotencyKey: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                description:
                  "Stable caller-generated ID for an identical retry. A new logical action needs a new ID.",
              },
              ...(includeApprovalId
                ? {
                    approvalId: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      description:
                        "Approval ID returned by a pending call. After human approval, retry the same tool with identical arguments and this ID.",
                    },
                  }
                : {}),
            },
            required: [
              ...(t.inputSchema.required ?? []),
              ...(requireIdempotencyKey ? ["idempotencyKey"] : []),
            ],
          }
        : t.inputSchema,
      annotations: t.annotations ?? MCP_TOOL_ANNOTATIONS[t.name],
      outputSchema: t.outputSchema ?? { type: "object", additionalProperties: true },
      // Task advertisement is honest: "optional" is emitted only for the
      // recorded, delegated scan tool and only when this server was built
      // with a task backend that can resolve get/result/cancel durably.
      // Everything else stays "forbidden".
      execution: {
        taskSupport:
          this.taskSupportEnabled && TASK_CAPABLE_TOOLS.has(t.name)
            ? ("optional" as const)
            : ("forbidden" as const),
      },
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

    // Validate the exact (sanitized) arguments against the tool's advertised
    // inputSchema before any approval or execution. Structured errors name
    // the offending fields so agents can correct the call.
    const argErrors = validateToolArgs(safeArgs, tool.inputSchema as Record<string, unknown>)
    if (argErrors.length > 0) {
      logger.warn("MCP tool call failed argument validation", { tool: name, argErrors })
      const error = {
        error: "Invalid tool arguments",
        tool: name,
        details: argErrors,
      }
      return {
        content: [{ type: "text", text: JSON.stringify(error) }],
        isError: true,
        structuredContent: error,
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
        if (decision.structuredContent) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(decision.structuredContent),
              },
            ],
            isError: true,
            structuredContent: decision.structuredContent,
          }
        }
        const error = {
          error: "Mutation was not authorized or could not be executed",
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
        return capToolResult(decision.result)
      }
      logger.info("MCP mutating tool approved", { tool: name })
    }

    logger.info("MCP tool call allowed", {
      tool: name,
      suspiciousPatterns:
        guardResult.detectedPatterns.length > 0 ? guardResult.detectedPatterns : undefined,
    })

    try {
      return capToolResult(await tool.handler(safeArgs))
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
