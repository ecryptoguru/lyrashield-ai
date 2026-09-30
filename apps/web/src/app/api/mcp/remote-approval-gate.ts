import {
  requireOAuthPermission,
  requirePermission,
  type OAuthAuthContext,
} from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import {
  claimOrGetAgentOperation,
  checkDelegatedOperationAuthorization,
  completeAgentOperation,
  failAgentOperation,
  toJsonObject,
  withWorkspaceRLS,
  TOOL_OPERATION_MAP,
} from "@lyrashield/db"
import {
  McpServer,
  McpToolResultSchema,
  extractScanIdFromToolResult,
  type McpToolResult,
  type RemoteApprovalGate,
} from "@lyrashield/mcp"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { z } from "zod"

const operationPermissions: Partial<Record<string, Permission>> = {
  "scan.create": PERMISSIONS.scan.create,
  "scan.cancel": PERMISSIONS.scan.cancel,
  "report.create": PERMISSIONS.report.create,
  "fix_proposal.create": PERMISSIONS.fix.create,
  "retest.create": PERMISSIONS.retest.create,
  "fix_pr.create": PERMISSIONS.fix.createPr,
  "scan_attachment.list": PERMISSIONS.scan.view,
  "scan_attachment.upload": PERMISSIONS.attachment.upload,
  "scan_attachment.delete": PERMISSIONS.attachment.delete,
}

const approvalIdSchema = z.string().min(1).max(128).optional()
const idempotencyKeySchema = z.string().min(1).max(128)

function denied(reason: string): { approved: false; reason: string } {
  return { approved: false, reason }
}

/**
 * Single response for every remote caller without a delegated OAuth
 * connection: connect over OAuth, then mutations run inside that grant. No
 * approval is created, nothing is executed and there is nothing to poll.
 */
function connectRequired(): {
  approved: false
  reason: string
  structuredContent: Record<string, unknown>
} {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  const message =
    "This action requires a connected LyraShield client. Connect over OAuth to authorize mutating tools inside a bounded grant."
  return {
    approved: false,
    reason: message,
    structuredContent: {
      code: "connect_required",
      message,
      connectUrl: `${base}/dashboard/connections`,
      docsUrl: "https://lyrashieldai.com/docs/approvals",
    },
  }
}

function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { approvalId, idempotencyKey, ...rest } = args
  void approvalId
  void idempotencyKey
  return rest
}

/**
 * Stamp the durable operation id onto a returned tool result so the MCP task
 * layer can bind a task id to this exact ledger row. Text payloads that hold
 * the same JSON document are rewritten consistently; other content is left
 * as-is. Applied to every approved return path — fresh execution, replay and
 * in-progress — so the binding is identical however the result was produced.
 */
function withOperationId(result: McpToolResult, operationId: string): McpToolResult {
  const structuredContent = { ...(result.structuredContent ?? {}), operationId }
  const content = result.content.map((item) => {
    if (item.type !== "text") return item
    try {
      const parsed: unknown = JSON.parse(item.text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...item, text: JSON.stringify({ ...(parsed as object), operationId }, null, 2) }
      }
    } catch {
      // Non-JSON text content — leave it verbatim.
    }
    return item
  })
  return { ...result, content, structuredContent }
}

async function resolveDelegatedScope(
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ targetId?: string; profile?: string } | null> {
  const has = (field: string) => args[field] !== undefined
  const only = (...allowed: string[]) =>
    ["targetId", "scanId", "findingId", "proposalId"].every(
      (field) => !has(field) || allowed.includes(field)
    )
  const targetInput = typeof args.targetId === "string" ? args.targetId : undefined
  if (has("targetId") && !targetInput) return null

  if (toolName === "lyrashield_scan_target" || toolName === "lyrashield_run_pr_scan") {
    if (!only("targetId")) return null
    return {
      targetId: targetInput,
      profile: typeof args.mode === "string" ? args.mode : undefined,
    }
  }

  if (
    toolName === "lyrashield_upload_scan_attachment" ||
    toolName === "lyrashield_delete_scan_attachment"
  ) {
    // Attachments are workspace-level resources; any target identifier is spoofable noise.
    return only() ? {} : null
  }

  if (toolName === "lyrashield_cancel_scan") {
    if (!only("targetId", "scanId") || typeof args.scanId !== "string") return null
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: args.scanId as string, workspaceId, deletedAt: null },
        select: { targetId: true },
      })
    )
    if (!scan?.targetId || (targetInput && targetInput !== scan.targetId)) return null
    return { targetId: scan.targetId }
  }

  if (toolName === "lyrashield_create_report") {
    if (!only("targetId", "scanId")) return null
    if (typeof args.scanId === "string") {
      const scan = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.scan.findFirst({
          where: { id: args.scanId as string, workspaceId, deletedAt: null },
          select: { targetId: true },
        })
      )
      if (!scan?.targetId || (targetInput && targetInput !== scan.targetId)) return null
      return { targetId: scan.targetId }
    }
    if (targetInput) {
      const target = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.target.findFirst({
          where: { id: targetInput, workspaceId, deletedAt: null },
          select: { id: true },
        })
      )
      return target ? { targetId: target.id } : null
    }
    return {}
  }

  if (toolName === "lyrashield_record_fix_proposal" || toolName === "lyrashield_verify_fix") {
    if (!only("findingId") || typeof args.findingId !== "string") return null
    const finding = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.findFirst({
        where: { id: args.findingId as string, workspaceId, deletedAt: null },
        select: { targetId: true, scanId: true },
      })
    )
    if (!finding?.targetId) return null
    if (toolName === "lyrashield_record_fix_proposal") return { targetId: finding.targetId }
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: finding.scanId, workspaceId, deletedAt: null },
        select: { mode: true },
      })
    )
    return scan?.mode ? { targetId: finding.targetId, profile: scan.mode } : null
  }

  if (toolName === "lyrashield_request_fix_pr") {
    if (!only("proposalId") || typeof args.proposalId !== "string") return null
    const proposal = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.fixProposal.findFirst({
        where: {
          id: args.proposalId as string,
          deletedAt: null,
          finding: { workspaceId, deletedAt: null },
        },
        select: { finding: { select: { targetId: true } } },
      })
    )
    return proposal?.finding.targetId ? { targetId: proposal.finding.targetId } : null
  }

  return only() ? {} : null
}

interface RemoteApprovalGateOptions {
  apiKeyInfo: {
    workspaceId: string
    scopes: string[]
    createdById: string
    keyId: string
  }
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
  oauthContext?: OAuthAuthContext
  toolContext: { apiBaseUrl: string; apiKey: string; fetchFn?: typeof fetch }
}

export function makeRemoteApprovalGate(
  options: RemoteApprovalGateOptions
): (toolName: string, args: Record<string, unknown>) => ReturnType<RemoteApprovalGate> {
  const { apiKeyInfo, toolContext } = options
  const { workspaceId, scopes } = apiKeyInfo

  return async (toolName, args) => {
    if (!scopes.includes("write") && !scopes.includes("lyrashield.write")) {
      return denied("This connection does not have write scope; mutating tools are refused.")
    }

    // Replay bypasses REST handlers, so recheck live membership and role before
    // returning stored data or claiming an operation, not just before execution.
    const permission = operationPermissions[TOOL_OPERATION_MAP[toolName]?.canonicalOperation ?? ""]
    if (!permission) return denied("This operation has no supported permission binding.")
    try {
      if (options.oauthContext) {
        if (
          options.oauthContext.userId !== apiKeyInfo.createdById ||
          options.oauthContext.workspaceId !== workspaceId ||
          (options.connection && options.oauthContext.connectionId !== options.connection.id)
        ) {
          throw new Error("FORBIDDEN")
        }
        await requireOAuthPermission(options.oauthContext, permission)
      } else {
        if (options.connection) throw new Error("FORBIDDEN")
        await requirePermission(workspaceId, permission)
      }
    } catch {
      return denied("Current workspace access does not authorize this operation.")
    }

    const parsedApprovalId = approvalIdSchema.safeParse(args.approvalId)
    if (!parsedApprovalId.success) return denied("Invalid approvalId")
    const approvalIdArg = parsedApprovalId.data
    const toolArgs = stripControlArgs(args)

    if (options.connection) {
      if (approvalIdArg) {
        return denied(
          "Connection-bound credentials cannot bypass their grant with a per-action approval. Update the connection scope instead."
        )
      }
      let delegatedScope: Awaited<ReturnType<typeof resolveDelegatedScope>>
      try {
        delegatedScope = await resolveDelegatedScope(workspaceId, toolName, toolArgs)
      } catch (error) {
        logger.warn("Could not resolve delegated MCP resource scope", {
          connectionId: options.connection.id,
          workspaceId,
          toolName,
          error: error instanceof Error ? error.name : "UnknownError",
        })
        return denied("The referenced resource could not be resolved for this workspace.")
      }
      if (!delegatedScope) {
        return denied(
          "The referenced resource is missing, out of scope or has conflicting identifiers."
        )
      }

      const authCheck = checkDelegatedOperationAuthorization({
        connection: options.connection,
        workspaceId,
        operationName: toolName,
        targetId: delegatedScope.targetId,
        profile: delegatedScope.profile,
      })

      if (authCheck.authorized) {
        const parsedIdempotencyKey = idempotencyKeySchema.safeParse(args.idempotencyKey)
        if (!parsedIdempotencyKey.success) {
          return denied("A stable idempotencyKey is required for delegated mutations.")
        }
        const idempotencyKey = parsedIdempotencyKey.data

        const claim = await claimOrGetAgentOperation({
          connectionId: options.connection.id,
          workspaceId,
          operationName: authCheck.canonicalOperation,
          idempotencyKey,
          authorizationVersion: options.connection.authorizationVersion,
          input: toolArgs,
        })

        if (claim.status === "REPLAY") {
          const storedResult = McpToolResultSchema.safeParse(claim.operation.result)
          if (!storedResult.success) {
            return denied(
              "The completed operation result is unavailable; the action will not be rerun."
            )
          }
          return {
            approved: true,
            result: withOperationId(storedResult.data, claim.operation.id),
          }
        }

        if (claim.status === "IN_PROGRESS") {
          const result = {
            status: claim.operation.status,
            operationId: claim.operation.id,
            message:
              "This operation is already in progress. Poll its status instead of retrying it.",
          }
          return {
            approved: true,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            },
          }
        }

        if (claim.status === "FAILED") {
          return denied(
            "This operation previously failed and will not be retried under the same idempotencyKey."
          )
        }

        if (claim.status === "CONFLICT") {
          return denied(
            "Idempotency conflict: operation already pending or failed with conflicting input."
          )
        }

        const executionServer = new McpServer({ toolContext, allowMutations: true })
        let toolResult: McpToolResult
        try {
          toolResult = await executionServer.callTool(toolName, toolArgs)
        } catch (error) {
          logger.error("Delegated MCP tool execution threw", {
            operationId: claim.operation.id,
            connectionId: options.connection.id,
            workspaceId,
            toolName,
            error: error instanceof Error ? error.message : String(error),
          })
          await failAgentOperation(claim.operation.id, workspaceId, {
            error: error instanceof Error ? error.message : String(error),
          })
          return denied("Delegated tool execution failed")
        }

        const stampedResult = withOperationId(toolResult, claim.operation.id)
        await completeAgentOperation(claim.operation.id, workspaceId, {
          // Point the ledger row at the durable scan when the tool produced
          // one — task recovery resolves the scan via this reference without
          // ever re-executing the tool.
          resultReference: extractScanIdFromToolResult(toolResult) ?? undefined,
          result: toJsonObject({
            content: stampedResult.content,
            isError: stampedResult.isError,
            structuredContent: stampedResult.structuredContent,
          }),
        })

        return { approved: true, result: stampedResult }
      }

      return denied(
        `${authCheck.reason}. Update this connection's authorized workflows or target scope.`
      )
    }

    return connectRequired()
  }
}
