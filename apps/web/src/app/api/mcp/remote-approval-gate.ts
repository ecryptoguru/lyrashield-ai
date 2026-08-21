import {
  claimApprovalExecution,
  completeApprovalExecution,
  createApproval,
  failApprovalExecution,
  findPendingApprovalByHash,
  getApproval,
  hashInput,
  verifyInputHash,
} from "@lyrashield/db"
import { McpServer, type McpToolResult, type RemoteApprovalGate } from "@lyrashield/mcp"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { checkApprovalCreateRateLimit } from "../../../lib/rate-limit"

const APPROVAL_TTL_MINUTES = 15

function approvalUrl(approvalId: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  return `${base}/agent-approvals/${approvalId}`
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
  const stored = approval.result as { content?: unknown[]; isError?: boolean } | undefined
  const content = Array.isArray(stored?.content)
    ? (stored.content as { type: string; text: string }[])
    : [{ type: "text", text: JSON.stringify(stored ?? approval.result) }]
  return { approved: true, result: { content, isError: stored?.isError } as McpToolResult }
}

function stripApprovalId(args: Record<string, unknown>): Record<string, unknown> {
  const { approvalId, ...rest } = args
  void approvalId
  return rest
}

export interface RemoteApprovalGateOptions {
  apiKeyInfo: {
    workspaceId: string
    scopes: string[]
    createdById: string
    keyId: string
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

    const approvalIdArg = (args.approvalId as string | undefined) ?? undefined
    const toolArgs = stripApprovalId(args)

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

    if (!verifyInputHash(approval.actionName, toolArgs, approval.inputHash)) {
      return denied("Submitted input does not match the requested action")
    }

    if (approval.expiresAt && approval.expiresAt < new Date()) {
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
