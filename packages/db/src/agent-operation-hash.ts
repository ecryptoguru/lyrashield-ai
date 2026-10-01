import { createHash } from "node:crypto"

/**
 * Pure canonical-input hashing for durable agent operations.
 *
 * Kept free of any Prisma/client imports so unit tests and callers can apply
 * the exact production hash — a changed input under the same idempotency key
 * must produce a different hash — without initializing the DB client.
 */
function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

export function hashOperationInput(operationName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ operationName, input }, sortKeysReplacer)
  return createHash("sha256").update(canonical).digest("hex")
}
