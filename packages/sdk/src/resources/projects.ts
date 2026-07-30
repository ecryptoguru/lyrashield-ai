import type { LyraShieldClient } from "../client"

export interface ListProjectsQuery {
  workspaceId?: string
  cursor?: string
  limit?: number
}

export interface CreateProjectInput {
  workspaceId?: string
  name: string
}

export function listProjects(client: LyraShieldClient, query: ListProjectsQuery = {}) {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return client.request("GET", qs ? `/projects?${qs}` : "/projects")
}

export function getProject(client: LyraShieldClient, id: string) {
  return client.request("GET", `/projects/${encodeURIComponent(id)}`)
}

export function createProject(client: LyraShieldClient, input: CreateProjectInput) {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/projects", { body })
}
