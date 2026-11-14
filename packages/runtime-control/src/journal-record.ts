import { createHmac, timingSafeEqual } from "node:crypto"
import { canonicalJson, sha256Hex } from "./canonical-json"
const JOURNAL_VERSION = 1
const MIN_SECRET_BYTES = 32
export class JournalReadLimitError extends Error {
  readonly code = "JOURNAL_READ_LIMIT"
}

export interface JournalRecord<T> {
  version: 1
  sequence: number
  previousHash: string
  hash: string
  signature: string
  payload: T
}

export class JournalIntegrityError extends Error {
  readonly code = "JOURNAL_INTEGRITY"

  constructor(message: string) {
    super(message)
    this.name = "JournalIntegrityError"
  }
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function signRecord(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex")
}

export function recordHash(record: Omit<JournalRecord<unknown>, "hash" | "signature">): string {
  return sha256Hex(
    canonicalJson({
      version: record.version,
      sequence: record.sequence,
      previousHash: record.previousHash,
      payload: record.payload,
    })
  )
}

export function validateSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`journal signing secret must be at least ${MIN_SECRET_BYTES} bytes`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function recordEnvelope(
  value: unknown
): Omit<JournalRecord<unknown>, "payload"> & { payload: unknown } {
  if (!isRecord(value)) throw new JournalIntegrityError("journal record is not an object")
  const { version, sequence, previousHash, hash, signature, payload } = value
  if (
    version !== JOURNAL_VERSION ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 1 ||
    typeof previousHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(previousHash) ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    throw new JournalIntegrityError("journal envelope is malformed")
  }
  return {
    version: JOURNAL_VERSION,
    sequence: sequence as number,
    previousHash,
    hash,
    signature,
    payload,
  }
}

export function validatedEnvelope<T>(
  value: unknown,
  validatePayload: (value: unknown) => T
): JournalRecord<T> {
  const envelope = recordEnvelope(value)
  // Capture before validation: validators may strip fields or mutate their input.
  const input = canonicalJson(value)
  const record = { ...envelope, payload: validatePayload(envelope.payload) }
  if (input !== canonicalJson(record)) {
    throw new JournalIntegrityError("journal envelope changed during validation")
  }
  return record
}

/** Verify one unchanged signed envelope; callers must separately authenticate its chain anchor. */
export function verifyJournalRecord<T>(
  value: unknown,
  secret: string,
  validatePayload: (value: unknown) => T
): JournalRecord<T> {
  validateSecret(secret)
  const record = validatedEnvelope(value, validatePayload)
  const { hash, signature, ...unsigned } = record
  const expectedHash = recordHash(unsigned)
  const expectedSignature = signRecord(secret, canonicalJson({ ...unsigned, hash: expectedHash }))
  if (!secureEqual(hash, expectedHash) || !secureEqual(signature, expectedSignature)) {
    throw new JournalIntegrityError("journal signature or record hash is invalid")
  }
  return record
}
