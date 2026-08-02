import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { ReportListSchema, ReportSchema } from "../schemas"

export interface CreateReportInput {
  workspaceId?: string
  scanId?: string
  title: string
  type?: string
}

export interface ListReportsQuery {
  workspaceId?: string
  scanId?: string
  cursor?: string
  limit?: number
}

export function listReports(
  client: LyraShieldClient,
  query: ListReportsQuery = {}
): Promise<z.infer<typeof ReportListSchema>> {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.scanId) params.set("scanId", query.scanId)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return client.request("GET", qs ? `/reports?${qs}` : "/reports", {
    parse: (data) => ReportListSchema.parse(data),
  })
}

export function createReport(
  client: LyraShieldClient,
  input: CreateReportInput
): Promise<z.infer<typeof ReportSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/reports", {
    body,
    parse: (data) => ReportSchema.parse(data),
  })
}
