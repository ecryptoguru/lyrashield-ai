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

const SENSITIVE_KEY =
  /pass|secret|token|key|body|content|message|text|summary|subject|email|authorization|cookie|credential/i
const MAX_META_BYTES = 4000

/** Drop sensitive keys, cap lengths, screen residual secrets — recursively. */
function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY.test(key)) return undefined
  if (typeof value === "string") return value.slice(0, 200)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (value instanceof Date) return value.toISOString()
  if (depth >= 4) return undefined
  if (Array.isArray(value)) {
    return value
      .slice(0, 25)
      .map((item) => sanitizeValue("", item, depth + 1))
      .filter((v) => v !== undefined)
  }
  if (typeof value === "object") {
    const nested: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitizeValue(k, v, depth + 1)
      if (clean !== undefined) nested[k] = clean
    }
    return nested
  }
  return undefined
}

function sanitizeMetadata(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!meta) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    const clean = sanitizeValue(k, v, 0)
    if (clean !== undefined) out[k] = clean
  }
  let json = screenSecrets(JSON.stringify(out)).text
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
