import type { LyraShieldClient } from "../client"

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

export function listScans(client: LyraShieldClient, query: ScanQuery = {}) {
  const params = buildScanParams(query, client)
  const qs = params.toString()
  return client.request("GET", qs ? `/scans?${qs}` : "/scans")
}

export function createScan(client: LyraShieldClient, input: ScanInput) {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/scans", { body })
}

export function getScan(client: LyraShieldClient, id: string, opts?: GetScanOptions) {
  const params = new URLSearchParams()
  const workspaceId = opts?.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  const qs = params.toString()
  const path = qs ? `/scans/${encodeURIComponent(id)}?${qs}` : `/scans/${encodeURIComponent(id)}`
  if (opts?.etag) {
    return client.request("GET", path, { etag: opts.etag })
  }
  return client.request("GET", path)
}

export function cancelScan(client: LyraShieldClient, id: string, workspaceId?: string) {
  const ws = workspaceId ?? client.workspaceId
  const body = ws ? { workspaceId: ws } : {}
  return client.request("POST", `/scans/${encodeURIComponent(id)}/cancel`, { body })
}
