import type { LyraShieldClient } from "../client"

export interface AgentApproval {
  id: string
  workspaceId: string
  actionName: string
  inputHash: string
  status: "PENDING" | "APPROVED" | "EXECUTED" | "DENIED" | "EXPIRED"
  input: Record<string, unknown>
  requestedById: string
  approvedById?: string | null
  approvedAt?: string | null
  deniedAt?: string | null
  executedAt?: string | null
  expiresAt?: string | null
  result?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface AgentApprovalQuery {
  workspaceId?: string
  status?: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED"
  cursor?: string
  limit?: number
}

export interface CreateAgentApprovalInput {
  workspaceId?: string
  actionName: string
  input: Record<string, unknown>
  expiresAt?: string
}

export interface PendingApprovalResult {
  status: "PENDING"
  approvalId: string
  approvalUrl: string
  message: string
}

function buildParams(query: AgentApprovalQuery, client: LyraShieldClient): URLSearchParams {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.status) params.set("status", query.status)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  return params
}

export function listAgentApprovals(client: LyraShieldClient, query: AgentApprovalQuery = {}) {
  const qs = buildParams(query, client).toString()
  return client.request<{
    items: AgentApproval[]
    nextCursor: string | null
  }>("GET", qs ? `/agent-approvals?${qs}` : "/agent-approvals")
}

export function createAgentApproval(client: LyraShieldClient, input: CreateAgentApprovalInput) {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request<AgentApproval>("POST", "/agent-approvals", { body })
}

export function approveAgentApproval(
  client: LyraShieldClient,
  id: string,
  input: { workspaceId?: string; input: Record<string, unknown> }
) {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request<AgentApproval>(
    "POST",
    `/agent-approvals/${encodeURIComponent(id)}/approve`,
    { body }
  )
}

export function denyAgentApproval(client: LyraShieldClient, id: string, workspaceId?: string) {
  const body = { workspaceId: workspaceId ?? client.workspaceId }
  return client.request<AgentApproval>("POST", `/agent-approvals/${encodeURIComponent(id)}/deny`, {
    body,
  })
}
