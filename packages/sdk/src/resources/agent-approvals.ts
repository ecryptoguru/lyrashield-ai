import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { AgentApprovalListSchema, AgentApprovalSchema } from "../schemas"

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

function buildParams(query: AgentApprovalQuery, client: LyraShieldClient): URLSearchParams {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.status) params.set("status", query.status)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  return params
}

export function listAgentApprovals(
  client: LyraShieldClient,
  query: AgentApprovalQuery = {}
): Promise<z.infer<typeof AgentApprovalListSchema>> {
  const qs = buildParams(query, client).toString()
  return client.request("GET", qs ? `/agent-approvals?${qs}` : "/agent-approvals", {
    parse: (data) => AgentApprovalListSchema.parse(data),
  })
}

export function createAgentApproval(
  client: LyraShieldClient,
  input: CreateAgentApprovalInput
): Promise<z.infer<typeof AgentApprovalSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/agent-approvals", {
    body,
    parse: (data) => AgentApprovalSchema.parse(data),
  })
}

export function approveAgentApproval(
  client: LyraShieldClient,
  id: string,
  input: { workspaceId?: string; input: Record<string, unknown> }
): Promise<z.infer<typeof AgentApprovalSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/agent-approvals/${encodeURIComponent(id)}/approve`, {
    body,
    parse: (data) => AgentApprovalSchema.parse(data),
  })
}

export function denyAgentApproval(
  client: LyraShieldClient,
  id: string,
  workspaceId?: string
): Promise<z.infer<typeof AgentApprovalSchema>> {
  const body = { workspaceId: workspaceId ?? client.workspaceId }
  return client.request("POST", `/agent-approvals/${encodeURIComponent(id)}/deny`, {
    body,
    parse: (data) => AgentApprovalSchema.parse(data),
  })
}
