import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { inspectJournalPath, journalPathsOverlap } from "./journal-paths"

// Matches the existing separate PostgreSQL mirror's identifier contract.
const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const secret = z.string().refine((value) => Buffer.byteLength(value) >= 32)
const compositionSchema = z
  .object({
    admission: z.literal("closed"),
    epochId: id,
    supervisorInstanceId: id,
    originalPath: z.string().min(1),
    independentPath: z.string().min(1),
    originalSigningSecret: secret,
    independentSigningSecret: secret,
  })
  .strict()

function effectiveSigningKey(secret: string): Buffer {
  const key = Buffer.from(secret)
  // HMAC-SHA256 hashes keys longer than its 64-byte block, then pads shorter
  // keys with zeros. Unequal raw secrets may therefore be the same signing key.
  const material = key.length > 64 ? createHash("sha256").update(key).digest() : key
  const block = Buffer.alloc(64)
  block.set(material)
  return block
}

/**
 * Read-only composition preflight. It cannot instantiate a production journal,
 * publish a checkpoint, provision an epoch or return physical-effect permission.
 * Path inspection does not establish native ownership against later replacement.
 */
export async function inspectSupervisorIndependentComposition(input: unknown) {
  const options = compositionSchema.parse(input)
  const originalKey = effectiveSigningKey(options.originalSigningSecret),
    independentKey = effectiveSigningKey(options.independentSigningSecret)
  if (timingSafeEqual(originalKey, independentKey))
    throw new Error("original and independent signing keys must differ")
  const original = inspectJournalPath(options.originalPath)
  const independent = inspectJournalPath(options.independentPath)
  if (journalPathsOverlap(original, independent))
    throw new Error(
      "original and independent journal paths alias or overlap a journal namespace, including case variants"
    )
  return Object.freeze({
    admission: "closed" as const,
    productionEligible: false as const,
    epochId: options.epochId,
    supervisorInstanceId: options.supervisorInstanceId,
    originalPath: original.canonical,
    independentPath: independent.canonical,
    reason:
      "Authenticated persisted full-command, scope, revocation and policy authority is not installed",
  })
}
