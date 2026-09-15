/**
 * Sanitized operational audit for Myra. Writes `myraAuditEvent` rows —
 * metadata only, never message bodies, tokens or secrets.
 */
import { prisma } from "@lyrashield/db"
import { screenSecrets } from "../sanitize"
import type { MyraDb } from "./db"

export type MyraActorType = "user" | "public_session" | "operator" | "system"

export interface AuditFields {
  accountId?: string | null
  publicSessionId?: string | null
  operatorId?: string | null
  workspaceId?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  metadata?: Record<string, unknown>
}

const SENSITIVE_KEY = /pass|secret|token|key|body|content|message|text|summary|subject|email|authorization|cookie|credential/i
const MAX_META_BYTES = 4000

/** Drop sensitive keys, cap lengths, screen residual secrets. */
function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!meta) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(k)) continue
    if (typeof v === "string") out[k] = v.slice(0, 200)
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v
    else if (v instanceof Date) out[k] = v.toISOString()
    else out[k] = JSON.parse(JSON.stringify(v)?.slice(0, 500) ?? "null")
  }
  let json = JSON.stringify(out)
  const screened = screenSecrets(json)
  json = screened.text
  if (json.length > MAX_META_BYTES) json = json.slice(0, MAX_META_BYTES)
  return JSON.parse(json) as Record<string, unknown>
}

export async function auditEvent(
  actorType: MyraActorType,
  fields: AuditFields,
  db: MyraDb = prisma
): Promise<void> {
  try {
    await db.myraAuditEvent.create({
      data: {
        actorType,
        accountId: fields.accountId ?? null,
        publicSessionId: fields.publicSessionId ?? null,
        operatorId: fields.operatorId ?? null,
        workspaceId: fields.workspaceId ?? null,
        action: fields.action,
        resourceType: fields.resourceType,
        resourceId: fields.resourceId ?? null,
        metadata: sanitizeMetadata(fields.metadata) ?? undefined,
      },
    })
  } catch {
    // Audit must never break the request path.
  }
}
