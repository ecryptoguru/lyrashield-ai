import type { LyraShieldClient } from "../client"
import { NotModified } from "../errors"
import { z } from "zod"
import { IdSchema, ScanListSchema, ScanSchema } from "../schemas"

export interface ScanQuery {
  workspaceId?: string
  targetId?: string
  goal?: string
  status?: string
  cursor?: string
  limit?: number
}

export interface ScanInput {
  workspaceId?: string
  targetId: string
  goal?: string
  mode?: string
}

export interface GetScanOptions {
  workspaceId?: string
  etag?: string
}

function buildScanParams(query: ScanQuery, client: LyraShieldClient): URLSearchParams {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.targetId) params.set("targetId", query.targetId)
  if (query.goal) params.set("goal", query.goal)
  if (query.status) params.set("status", query.status)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  return params
}

export function listScans(
  client: LyraShieldClient,
  query: ScanQuery = {}
): Promise<z.infer<typeof ScanListSchema>> {
  const params = buildScanParams(query, client)
  const qs = params.toString()
  return client.request("GET", qs ? `/scans?${qs}` : "/scans", {
    parse: (data) => ScanListSchema.parse(data),
  })
}

export function createScan(
  client: LyraShieldClient,
  input: ScanInput
): Promise<z.infer<typeof ScanSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/scans", {
    body,
    parse: (data) => ScanSchema.parse(data),
  })
}

export function getScan(
  client: LyraShieldClient,
  id: string,
  opts?: GetScanOptions
): Promise<z.infer<typeof ScanSchema> | NotModified> {
  const params = new URLSearchParams()
  const workspaceId = opts?.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  const qs = params.toString()
  const path = qs ? `/scans/${encodeURIComponent(id)}?${qs}` : `/scans/${encodeURIComponent(id)}`
  if (opts?.etag) {
    return client.request("GET", path, {
      etag: opts.etag,
      parse: (data) => ScanSchema.parse(data),
    })
  }
  return client.request("GET", path, {
    parse: (data) => ScanSchema.parse(data),
  })
}

export function cancelScan(
  client: LyraShieldClient,
  id: string,
  workspaceId?: string
): Promise<z.infer<typeof IdSchema>> {
  const ws = workspaceId ?? client.workspaceId
  const body = ws ? { workspaceId: ws } : {}
  return client.request("POST", `/scans/${encodeURIComponent(id)}`, {
    body,
    parse: (data) => IdSchema.parse(data),
  })
}
