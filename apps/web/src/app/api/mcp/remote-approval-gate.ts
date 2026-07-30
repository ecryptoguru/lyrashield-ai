import {
  createApproval,
  executeApproval,
  findPendingApprovalByHash,
  getApproval,
  hashInput,
  verifyInputHash,
  type VerifiedApiKey,
} from "@lyrashield/db"
import { McpServer, type McpToolResult, type RemoteApprovalGate } from "@lyrashield/mcp"
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

function stripApprovalId(args: Record<string, unknown>): Record<string, unknown> {
  const { approvalId, ...rest } = args
  void approvalId
  return rest
}

export interface RemoteApprovalGateOptions {
  apiKeyInfo: VerifiedApiKey
  toolContext: { apiBaseUrl: string; apiKey: string; fetchFn?: typeof fetch }
}

export function makeRemoteApprovalGate(options: RemoteApprovalGateOptions): RemoteApprovalGate {
  const { apiKeyInfo, toolContext } = options
  const { workspaceId, scopes, createdById } = apiKeyInfo

  return async (toolName, args) => {
    if (!scopes.includes("write")) {
      return denied("This API key does not have write scope; mutating tools are refused.")
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
      return denied(`Approval not found: ${approvalIdArg}`)
    }

    if (!verifyInputHash(approval.actionName, toolArgs, approval.inputHash)) {
      return denied("Submitted input does not match the requested action")
    }

    if (approval.expiresAt && approval.expiresAt < new Date()) {
      return denied("Approval has expired. Request a new approval.")
    }

    if (approval.status === "EXECUTED") {
      const stored = approval.result as { content?: unknown[]; isError?: boolean } | undefined
      const content = Array.isArray(stored?.content)
        ? (stored.content as { type: string; text: string }[])
        : [{ type: "text", text: JSON.stringify(stored ?? approval.result) }]
      return { approved: true, result: { content, isError: stored?.isError } as McpToolResult }
    }

    if (approval.status === "PENDING") {
      return pendingDecision(approval.id)
    }

    if (approval.status !== "APPROVED") {
      return denied(`Approval is ${approval.status.toLowerCase()}`)
    }

    // Execute the approved action and store the result for idempotent replays.
    const executionServer = new McpServer({ toolContext, allowMutations: true })
    const toolResult = await executionServer.callTool(toolName, toolArgs)

    const storedResult = { content: toolResult.content, isError: toolResult.isError }
    const executed = await executeApproval(approval.id, workspaceId, storedResult)

    if (!executed) {
      // Another concurrent request may have won the race; return the stored result.
      const latest = await getApproval(approval.id, workspaceId)
      const stored = latest?.result as { content?: unknown[]; isError?: boolean } | undefined
      if (latest?.status === "EXECUTED" && stored) {
        const content = Array.isArray(stored.content)
          ? (stored.content as { type: string; text: string }[])
          : [{ type: "text", text: JSON.stringify(stored) }]
        return { approved: true, result: { content, isError: stored.isError } as McpToolResult }
      }
      return pendingDecision(approval.id)
    }

    return { approved: true, result: toolResult }
  }
}
