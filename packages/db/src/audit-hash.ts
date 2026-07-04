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

/**
 * Compute the hash for an audit log entry, chaining it to the previous entry's hash.
 * Uses SHA-256 over a canonical JSON string of the fields + prevHash.
 *
 * @returns The hex-encoded SHA-256 hash to store on the AuditLog record.
 */
export function computeAuditHash(
  entry: AuditLogChainFields,
  prevHash: string | null,
): string {
  const payload = {
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

  const json = JSON.stringify(payload, Object.keys(payload).sort())
  return createHash("sha256").update(json, "utf8").digest("hex")
}

/**
 * Verify the integrity of a chain of audit log entries.
 * Returns true if every entry's hash matches the recomputed value.
 */
export function verifyAuditChain(
  entries: Array<AuditLogChainFields & { hash: string | null; prevHash: string | null }>,
): boolean {
  let expectedPrevHash: string | null = null

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) return false

    const computed = computeAuditHash(entry, entry.prevHash)
    if (entry.hash !== computed) return false

    expectedPrevHash = entry.hash
  }

  return true
}
