import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { ProjectListSchema, ProjectSchema } from "../schemas"

export interface ListProjectsQuery {
  workspaceId?: string
  cursor?: string
  limit?: number
}

export interface CreateProjectInput {
  workspaceId?: string
  name: string
}

export function listProjects(
  client: LyraShieldClient,
  query: ListProjectsQuery = {}
): Promise<z.infer<typeof ProjectListSchema>> {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return client.request("GET", qs ? `/projects?${qs}` : "/projects", {
    parse: (data) => ProjectListSchema.parse(data),
  })
}

export function getProject(
  client: LyraShieldClient,
  id: string
): Promise<z.infer<typeof ProjectSchema>> {
  return client.request("GET", `/projects/${encodeURIComponent(id)}`, {
    parse: (data) => ProjectSchema.parse(data),
  })
}

export function createProject(
  client: LyraShieldClient,
  input: CreateProjectInput
): Promise<z.infer<typeof ProjectSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/projects", {
    body,
    parse: (data) => ProjectSchema.parse(data),
  })
}
