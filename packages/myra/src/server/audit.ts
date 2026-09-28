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
  if (typeof value === "string") return screenSecrets(value).text.slice(0, 200)
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

function trimLastMetadataEntry(value: Record<string, unknown> | unknown[]): boolean {
  if (Array.isArray(value)) {
    if (value.length === 0) return false
    const last = value[value.length - 1]
    if (
      last !== null &&
      typeof last === "object" &&
      trimLastMetadataEntry(last as Record<string, unknown> | unknown[])
    ) {
      return true
    }
    value.pop()
    return true
  }

  const lastKey = Object.keys(value).at(-1)
  if (lastKey === undefined) return false
  const last = value[lastKey]
  if (
    last !== null &&
    typeof last === "object" &&
    trimLastMetadataEntry(last as Record<string, unknown> | unknown[])
  ) {
    return true
  }
  delete value[lastKey]
  return true
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
  if (Buffer.byteLength(JSON.stringify(out), "utf8") <= MAX_META_BYTES) return out

  out.truncated = true
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_META_BYTES) {
    const lastKey = Object.keys(out)
      .filter((key) => key !== "truncated")
      .at(-1)
    if (lastKey === undefined) return { truncated: true }
    const last = out[lastKey]
    if (
      last !== null &&
      typeof last === "object" &&
      trimLastMetadataEntry(last as Record<string, unknown> | unknown[])
    ) {
      continue
    }
    delete out[lastKey]
  }
  return out
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
