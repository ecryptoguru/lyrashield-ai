import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Pure canonical-input hashing for durable agent operations.
 *
 * Kept free of any Prisma/client imports so unit tests and callers can apply
 * the exact production hash — a changed input under the same idempotency key
 * must produce a different hash — without initializing the DB client.
 */
export function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = Object.create(null)
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

const ADMISSION_PROOF_HASH = /^[0-9a-f]{64}$/

/** Hash a one-time admission proof before persistence. */
export function hashDelegatedAdmissionProof(proof: string): string {
  return createHash("sha256").update(proof, "utf8").digest("hex")
}

/** Compare a presented proof with its persisted SHA-256 in constant time. */
export function verifyDelegatedAdmissionProof(proof: string, expectedHash: string | null): boolean {
  if (!proof || !expectedHash || !ADMISSION_PROOF_HASH.test(expectedHash)) return false
  const actual = Buffer.from(hashDelegatedAdmissionProof(proof), "hex")
  const expected = Buffer.from(expectedHash, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
