import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import {
  claimOrGetAgentOperation,
  checkDelegatedOperationAuthorization,
  completeAgentOperation,
  failAgentOperation,
  withWorkspaceRLS,
  TOOL_OPERATION_MAP,
} from "@lyrashield/db"
import { McpServer, type McpToolResult, type RemoteApprovalGate } from "@lyrashield/mcp"
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

async function resolveDelegatedScope(
  workspaceId: string,
  toolName: string,
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
  if (typeof args.proposalId === "string") {
    const proposalId = args.proposalId
    const proposal = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.fixProposal.findFirst({
        where: { id: proposalId, deletedAt: null, finding: { workspaceId, deletedAt: null } },
        select: { findingId: true },
      })
    )
    if (!proposal) return {}
    const finding = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.findFirst({
        where: { id: proposal.findingId, workspaceId, deletedAt: null },
        select: { targetId: true },
      })
    )
    // fix_pr.create is non-billable: like cancellation, the gate must not
    // resolve the scan's recorded mode into a profile check.
    return { targetId: finding?.targetId ?? undefined }
  }
  if (typeof args.scanId === "string") {
    const scanId = args.scanId
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { targetId: true, mode: true },
      })
    )
    // Cancellation does not spend on the scan's recorded profile — a
    // cancel-scoped grant must not also require a billable profile grant.
    // The profile is only resolved for billable scanId-scoped tools (retest).
    return {
      targetId: scan?.targetId ?? undefined,
      profile: toolName === "lyrashield_cancel_scan" ? undefined : scan?.mode,
    }
  }
  return {}
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
  toolContext: { apiBaseUrl: string; apiKey: string; fetchFn?: typeof fetch }
}

export function makeRemoteApprovalGate(options: RemoteApprovalGateOptions): RemoteApprovalGate {
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
      const { targetId, profile } = await resolveDelegatedScope(workspaceId, toolName, toolArgs)

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

    return connectRequired()
  }
}
