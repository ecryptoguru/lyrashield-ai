import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import {
  claimApprovalExecution,
  claimOrGetAgentOperation,
  checkDelegatedOperationAuthorization,
  completeAgentOperation,
  completeApprovalExecution,
  createApproval,
  failAgentOperation,
  failApprovalExecution,
  findPendingApprovalByHash,
  getApproval,
  hashInput,
  verifyInputHash,
  withWorkspaceRLS,
  TOOL_OPERATION_MAP,
} from "@lyrashield/db"
import { McpServer, type McpToolResult, type RemoteApprovalGate } from "@lyrashield/mcp"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { z } from "zod"
import { checkApprovalCreateRateLimit } from "../../../lib/rate-limit"

const operationPermissions: Partial<Record<string, Permission>> = {
  "scan.create": PERMISSIONS.scan.create,
  "report.create": PERMISSIONS.report.create,
  "fix_proposal.create": PERMISSIONS.fix.create,
  "retest.create": PERMISSIONS.retest.create,
  "fix_pr.create": PERMISSIONS.fix.createPr,
}

const APPROVAL_TTL_MINUTES = 15
const approvalIdSchema = z.string().min(1).max(128).optional()
const idempotencyKeySchema = z.string().min(1).max(128)

function approvalUrl(approvalId: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  return `${base}/dashboard/approvals#approval-${encodeURIComponent(approvalId)}`
}

function pendingDecision(approvalId: string): {
  approved: false
  pending: true
  approvalId: string
  approvalUrl: string
  reason: string
} {
  return {
    approved: false,
    pending: true,
    approvalId,
    approvalUrl: approvalUrl(approvalId),
    reason:
      "This action requires human approval. Poll with the same arguments and approvalId once approved.",
  }
}

function denied(reason: string): { approved: false; reason: string } {
  return { approved: false, reason }
}

type StoredApproval = Awaited<ReturnType<typeof getApproval>>

/** Replay a stored EXECUTED result without re-running the tool. */
function storedResult(approval: NonNullable<StoredApproval>): {
  approved: true
  result: McpToolResult
} {
  const stored = approval.result as
    | {
        content?: unknown[]
        isError?: boolean
        structuredContent?: unknown
      }
    | undefined
  const content = Array.isArray(stored?.content)
    ? (stored.content as { type: string; text: string }[])
    : [{ type: "text", text: JSON.stringify(stored ?? approval.result) }]
  let structured = z.record(z.string(), z.unknown()).safeParse(stored?.structuredContent)
  // Older executions stored only the JSON text projection. Restore its
  // structured counterpart without rerunning the already executed action.
  if (!structured.success && content.length === 1 && content[0]?.type === "text") {
    try {
      const data: unknown = JSON.parse(content[0].text)
      structured = z
        .record(z.string(), z.unknown())
        .safeParse(data && typeof data === "object" && !Array.isArray(data) ? data : { data })
    } catch {
      // Malformed historical results cannot authorize another execution.
    }
  }
  if (!structured.success) {
    const error = { error: "Stored approval result is unavailable; action will not be rerun." }
    return {
      approved: true,
      result: {
        content: [{ type: "text", text: JSON.stringify(error) }],
        structuredContent: error,
        isError: true,
      },
    }
  }
  return {
    approved: true,
    result: {
      content,
      isError: stored?.isError,
      structuredContent: structured.data,
    } as McpToolResult,
  }
}

function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { approvalId, idempotencyKey, ...rest } = args
  void approvalId
  void idempotencyKey
  return rest
}

async function resolveDelegatedScope(
  workspaceId: string,
  args: Record<string, unknown>
): Promise<{ targetId?: string; profile?: string }> {
  if (typeof args.targetId === "string") {
    return {
      targetId: args.targetId,
      profile: typeof args.mode === "string" ? args.mode : undefined,
    }
  }
  if (typeof args.findingId === "string") {
    const findingId = args.findingId
    const finding = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.findFirst({
        where: { id: findingId, workspaceId, deletedAt: null },
        select: { targetId: true, scanId: true },
      })
    )
    if (!finding) return {}
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: finding.scanId, workspaceId, deletedAt: null },
        select: { mode: true },
      })
    )
    return { targetId: finding.targetId ?? undefined, profile: scan?.mode }
  }
  if (typeof args.scanId === "string") {
    const scanId = args.scanId
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { targetId: true, mode: true },
      })
    )
    return { targetId: scan?.targetId ?? undefined, profile: scan?.mode }
  }
  return {}
}

export interface RemoteApprovalGateOptions {
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
  toolContext: { apiBaseUrl: string; apiKey: string; fetchFn?: typeof fetch }
}

export function makeRemoteApprovalGate(options: RemoteApprovalGateOptions): RemoteApprovalGate {
  const { apiKeyInfo, toolContext } = options
  const { workspaceId, scopes, createdById } = apiKeyInfo

  return async (toolName, args) => {
    if (!scopes.includes("write") && !scopes.includes("lyrashield.write")) {
      return denied("This connection does not have write scope; mutating tools are refused.")
    }

    // Replay bypasses REST handlers, so recheck live membership and role before
    // returning stored data or claiming an operation, not just before execution.
    const permission = operationPermissions[TOOL_OPERATION_MAP[toolName]?.canonicalOperation ?? ""]
    if (!permission) return denied("This operation has no supported permission binding.")
    try {
      await requirePermission(workspaceId, permission)
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
      const { targetId, profile } = await resolveDelegatedScope(workspaceId, toolArgs)

      const authCheck = checkDelegatedOperationAuthorization({
        connection: options.connection,
        workspaceId,
        operationName: toolName,
        targetId,
        profile,
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
          if (!claim.operation.result) {
            return denied(
              "The completed operation result is unavailable; the action will not be rerun."
            )
          }
          return {
            approved: true,
            result: claim.operation.result as unknown as McpToolResult,
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

        await completeAgentOperation(claim.operation.id, workspaceId, {
          result: {
            content: toolResult.content,
            isError: toolResult.isError,
            structuredContent: toolResult.structuredContent,
          },
        })

        return { approved: true, result: toolResult }
      }

      return denied(
        `${authCheck.reason}. Update this connection's authorized workflows or target scope.`
      )
    }

    if (!approvalIdArg) {
      const rate = await checkApprovalCreateRateLimit(workspaceId)
      if (rate.limited) {
        return denied("Approval creation rate limit exceeded. Please wait before retrying.")
      }

      const inputHash = hashInput(toolName, toolArgs)
      const existing = await findPendingApprovalByHash(workspaceId, toolName, inputHash)
      if (existing) {
        return pendingDecision(existing.id)
      }

      const approval = await createApproval({
        workspaceId,
        actionName: toolName,
        input: toolArgs,
        requestedById: createdById,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60 * 1000),
      })

      return pendingDecision(approval.id)
    }

    const approval = await getApproval(approvalIdArg, workspaceId)
    if (!approval) {
      // Includes approvals that exist but belong to another workspace: fail closed.
      return denied(`Approval not found: ${approvalIdArg}`)
    }

    if (
      approval.actionName !== toolName ||
      !verifyInputHash(toolName, toolArgs, approval.inputHash)
    ) {
      return denied("Submitted input does not match the requested action")
    }

    if (approval.expiresAt && approval.expiresAt <= new Date()) {
      return denied("Approval has expired. Request a new approval.")
    }

    if (approval.status === "EXECUTED") {
      return storedResult(approval)
    }

    if (approval.status === "PENDING") {
      return pendingDecision(approval.id)
    }

    if (approval.status !== "APPROVED") {
      return denied(`Approval is ${approval.status.toLowerCase()}`)
    }

    // Claim the authorization BEFORE any side effect. Exactly one concurrent
    // poller wins the claim; the hash and expiry are re-enforced inside the
    // claim predicate so a raced request can never execute stale input.
    const claimed = await claimApprovalExecution(approval.id, workspaceId, approval.inputHash)

    if (!claimed) {
      const latest = await getApproval(approval.id, workspaceId)
      if (latest?.status === "EXECUTED" && latest.result != null) {
        return storedResult(latest)
      }
      return pendingDecision(approval.id)
    }

    const executionServer = new McpServer({ toolContext, allowMutations: true })
    let toolResult: McpToolResult
    try {
      toolResult = await executionServer.callTool(toolName, toolArgs)
    } catch (error) {
      logger.error("Approved MCP tool execution threw", {
        approvalId: approval.id,
        workspaceId,
        actionName: toolName,
        error: error instanceof Error ? error.message : String(error),
      })
      const errorResult = {
        content: [{ type: "text", text: JSON.stringify({ error: "Tool execution failed" }) }],
        isError: true,
      }
      const outcome = await failApprovalExecution(approval.id, workspaceId, errorResult)
      return outcome === "RETRYABLE"
        ? pendingDecision(approval.id)
        : denied("Approval execution failed; request a new approval.")
    }

    const settled = await completeApprovalExecution(approval.id, workspaceId, {
      content: toolResult.content,
      isError: toolResult.isError,
      structuredContent: toolResult.structuredContent,
    })

    if (!settled) {
      // The claim was lost after the fact (should not happen — only the claim
      // owner settles); fall back to whatever state is now stored.
      const latest = await getApproval(approval.id, workspaceId)
      if (latest?.status === "EXECUTED" && latest.result != null) {
        return storedResult(latest)
      }
      return pendingDecision(approval.id)
    }

    return { approved: true, result: toolResult }
  }
}
