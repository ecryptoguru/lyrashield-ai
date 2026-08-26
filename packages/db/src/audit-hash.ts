import { createHash } from "crypto"

/**
 * Fields from an AuditLog record that participate in the hash-chain.
 * The hash is computed over a canonical JSON representation of these fields
 * concatenated with the previous record's hash (prevHash).
 */
export interface AuditLogChainFields {
  id: string
  workspaceId: string
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  ipAddress: string | null
  userAgent: string | null
  metadata: unknown
  createdAt: Date
}

const AUDIT_HASH_V2_PREFIX = "v2:"

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

function auditPayload(entry: AuditLogChainFields, prevHash: string | null) {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    metadata: entry.metadata ?? null,
    createdAt: entry.createdAt.toISOString(),
    prevHash: prevHash ?? null,
  }
}

function legacyAuditHash(entry: AuditLogChainFields, prevHash: string | null): string {
  // Compatibility only: legacy hashes did not bind nested metadata. Existing
  // chains remain readable, while every new record uses the v2 format below.
  const payload = auditPayload(entry, prevHash)
  const json = JSON.stringify(payload, Object.keys(payload).sort())
  return createHash("sha256").update(json, "utf8").digest("hex")
}

/**
 * Compute the hash for an audit log entry, chaining it to the previous entry's hash.
 * Uses SHA-256 over a canonical JSON string of the fields + prevHash.
 *
 * @returns The versioned, hex-encoded SHA-256 hash to store on the AuditLog record.
 */
export function computeAuditHash(entry: AuditLogChainFields, prevHash: string | null): string {
  const json = JSON.stringify(canonicalize(auditPayload(entry, prevHash)))
  return `${AUDIT_HASH_V2_PREFIX}${createHash("sha256").update(json, "utf8").digest("hex")}`
}

/**
 * Verify the integrity of a chain of audit log entries.
 * Returns true if every entry's hash matches the recomputed value.
 */
export function verifyAuditChain(
  entries: Array<AuditLogChainFields & { hash: string | null; prevHash: string | null }>
): boolean {
  let expectedPrevHash: string | null = null

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) return false

    const computed: string = entry.hash?.startsWith(AUDIT_HASH_V2_PREFIX)
      ? computeAuditHash(entry, entry.prevHash)
      : legacyAuditHash(entry, entry.prevHash)
    if (entry.hash !== computed) return false

    expectedPrevHash = entry.hash
  }

  return true
}
