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
  idempotencyKey?: string
  workspaceId?: string
  targetId: string
  goal?: string
  mode?: string
  /** Optional workflow selection; the server owns the execution plan. */
  workflow?: "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"
  /** Review Changes comparison refs (branch names or full SHAs). */
  baseRef?: string
  headRef?: string
  /**
   * Immutable input-evidence references recorded into the server-owned
   * execution plan. IDs name previously staged workspace artifacts — never
   * host paths — and are validated again at the staging boundary.
   */
  attachmentIds?: string[]
  /**
   * AUTHENTICATED_ASSESSMENT only: the recorded scoped authorization
   * reference. The gated beta is denied server-side unless the deployment
   * enables it for this workspace/target. Never a credential.
   */
  authorizationRef?: string
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
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "idempotencyKey")),
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/scans", {
    body,
    headers: { "Idempotency-Key": input.idempotencyKey ?? crypto.randomUUID() },
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
