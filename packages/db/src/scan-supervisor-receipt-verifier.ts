/**
 * Supervisor receipt HMAC verifier (broker side, pure — no DB, no raw secrets).
 *
 * Contract with the supervisor (see supervisor-task6-interface-audit-20261106.md #1–#3):
 * - The supervisor journal recipe is: `hash = sha256Hex(canonicalJson({version,
 *   sequence, previousHash, payload}))`, then
 *   `signature = HMAC-SHA256(secret, canonicalJson({version, sequence,
 *   previousHash, payload, hash}))` hex. This verifier replicates that recipe
 *   exactly.
 * - `canonicalJson` sorts object keys recursively then `JSON.stringify`s, so
 *   field order in the source object does not change the signed bytes; the
 *   canonical field list is documented below for audit clarity.
 * - `supervisorInstanceId` is embedded in every journal payload (supervisor
 *   side) and in the returned receipt. The verifier requires an own
 *   enumerable data property `payload.supervisorInstanceId` covered by the
 *   signature. An optional top-level instance id must agree but never supplies
 *   the signed identity.
 *   Legacy payloads without a signed instance are unavailable for verification.
 * - The broker never holds the raw HMAC secret. A future gateway loads the
 *   secret from its key store (keyed by `supervisorInstanceId` /
 *   `keyId` in a ScanSupervisorKey-style metadata table) and supplies it as
 *   `secret`. The optional `expectedKeyHash` is `sha256Hex(secret)` stored in
 *   that metadata table; when supplied, the verifier checks it binds the
 *   supplied secret to the expected key.
 * - Sequence/previousHash chaining is checked against the caller's
 *   `expectedSequence` / `expectedPreviousHash` when supplied. Callers that
 *   mirror receipts in order must pass both; a single-record verification
 *   without them still validates hash and signature but not contiguity.
 * - A successful result proves only that the bytes match the supplied key and
 *   expectations. It does not authenticate the key source, bind an epoch or
 *   command to persisted authority, or prove absence or permit release.
 *
 * TODO (later step, not in scope): mirroring service (`recordSupervisorReceiptTx`)
 * that, inside a lockOperation transaction, verifies receipts with this
 * function and inserts `ScanSupervisorReceipt` rows plus
 * `ScanPhysicalExecutionTransition` rows. Also: outbox dispatcher and
 * epoch-bound auth for the supervisor control channel. This file keeps scope
 * to verification only.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const SUPERVISOR_RECEIPT_DOMAIN = "lyrashield-supervisor-receipt/1"
export const SUPERVISOR_RECEIPT_VERSION = 1
/** Mirrors the supervisor journal's minimum HMAC key length. */
const MIN_SUPERVISOR_SECRET_BYTES = 32
export const SUPERVISOR_RECEIPT_CANONICAL_FIELDS = [
  "version",
  "sequence",
  "previousHash",
  "payload",
  "hash",
] as const

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const normalized: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(record).sort()) normalized[key] = normalize(record[key])
    return normalized
  }
  return value
}

/**
 * Canonical JSON: recursively sort object keys, then JSON.stringify.
 * Must match `packages/runtime-control/src/canonical-json.ts` exactly.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export interface SupervisorReceiptUnsigned {
  version: number
  sequence: number
  previousHash: string
  payload: unknown
}

/**
 * Canonicalize an unsigned receipt (and, when supplied, its hash) to the
 * exact string covered by the HMAC. With `hash` supplied this is the HMAC
 * input; without it this is the hash input.
 */
export function canonicalizeSupervisorReceipt(
  unsigned: SupervisorReceiptUnsigned,
  hash?: string
): string {
  if (hash === undefined) {
    return canonicalJson({
      version: unsigned.version,
      sequence: unsigned.sequence,
      previousHash: unsigned.previousHash,
      payload: unsigned.payload,
    })
  }
  return canonicalJson({
    version: unsigned.version,
    sequence: unsigned.sequence,
    previousHash: unsigned.previousHash,
    payload: unsigned.payload,
    hash,
  })
}

export interface SupervisorReceiptRecord {
  version: number
  sequence: number
  previousHash: string
  hash: string
  signature: string
  payload: unknown
  supervisorInstanceId?: string
}

export interface VerifySupervisorReceiptHmacInput {
  record: SupervisorReceiptRecord
  expectedInstanceId: string
  /** Verified secret from the caller's key store. Never logged. */
  secret: string | Buffer
  /** sha256Hex(secret) from ScanSupervisorKey-style metadata, when known. */
  expectedKeyHash?: string
  /** Expected sequence when mirroring in order; omit for single-record checks. */
  expectedSequence?: number
  /** Expected predecessor hash when mirroring in order. */
  expectedPreviousHash?: string
}

export type VerifySupervisorReceiptHmacResult =
  | { ok: true; sequence: number; supervisorInstanceId: string }
  | {
      ok: false
      code:
        | "INSTANCE_MISMATCH"
        | "INVALID_VERSION"
        | "INVALID_SEQUENCE"
        | "INVALID_HASH"
        | "INVALID_SIGNATURE"
        | "CHAIN_MISMATCH"
        | "HASH_MISMATCH"
        | "SIGNATURE_MISMATCH"
        | "KEY_MISMATCH"
        | "MISSING_INSTANCE"
        | "INVALID_PAYLOAD"
        | "INVALID_SECRET"
      reason: string
    }

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function payloadInstanceId(payload: unknown): string | null {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const property = Object.getOwnPropertyDescriptor(payload, "supervisorInstanceId")
    if (property?.enumerable && "value" in property && typeof property.value === "string")
      return property.value
  }
  return null
}

/**
 * Resolve the instance id without trusting an unsigned envelope over the
 * signed payload. An envelope id is optional and must agree when present;
 * a missing signed payload id is always unavailable.
 */
function resolveInstanceId(record: SupervisorReceiptRecord): {
  instanceId: string | null
  envelopePayloadMismatch: boolean
} {
  const envelope = record.supervisorInstanceId
  const signed = payloadInstanceId(record.payload)
  if (envelope !== undefined && typeof envelope !== "string") {
    return { instanceId: null, envelopePayloadMismatch: false }
  }
  if (typeof envelope === "string" && signed !== null && envelope !== signed) {
    return { instanceId: null, envelopePayloadMismatch: true }
  }
  return {
    instanceId: signed,
    envelopePayloadMismatch: false,
  }
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

/**
 * Verify a supervisor receipt record. Pure and synchronous; performs no I/O.
 * Returns a discriminated result so callers can map failures to their own
 * error codes without try/catch.
 */
export function verifySupervisorReceiptHmac(
  input: VerifySupervisorReceiptHmacInput
): VerifySupervisorReceiptHmacResult {
  const { record, expectedInstanceId, secret } = input
  const secretBytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8")
  if (secretBytes.length < MIN_SUPERVISOR_SECRET_BYTES) {
    return {
      ok: false,
      code: "INVALID_SECRET",
      reason: `supervisor HMAC secret must be at least ${MIN_SUPERVISOR_SECRET_BYTES} bytes`,
    }
  }
  const resolved = resolveInstanceId(record)
  if (resolved.envelopePayloadMismatch) {
    return {
      ok: false,
      code: "INSTANCE_MISMATCH",
      reason: "envelope supervisorInstanceId does not match the signed payload",
    }
  }
  const instanceId = resolved.instanceId
  if (instanceId === null || instanceId === "")
    return {
      ok: false,
      code: "MISSING_INSTANCE",
      reason: "receipt carries no supervisorInstanceId",
    }
  if (instanceId !== expectedInstanceId)
    return {
      ok: false,
      code: "INSTANCE_MISMATCH",
      reason: `receipt instance ${instanceId} does not match expected ${expectedInstanceId}`,
    }
  if (record.version !== SUPERVISOR_RECEIPT_VERSION)
    return { ok: false, code: "INVALID_VERSION", reason: "unsupported receipt version" }
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1)
    return { ok: false, code: "INVALID_SEQUENCE", reason: "sequence must be a positive integer" }
  if (!isSha256Hex(record.previousHash))
    return { ok: false, code: "INVALID_HASH", reason: "previousHash is not sha256 hex" }
  if (!isSha256Hex(record.hash))
    return { ok: false, code: "INVALID_HASH", reason: "hash is not sha256 hex" }
  if (!isSha256Hex(record.signature))
    return { ok: false, code: "INVALID_SIGNATURE", reason: "signature is not HMAC-SHA256 hex" }
  if (input.expectedSequence !== undefined && record.sequence !== input.expectedSequence)
    return {
      ok: false,
      code: "CHAIN_MISMATCH",
      reason: `sequence ${record.sequence} does not match expected ${input.expectedSequence}`,
    }
  if (
    input.expectedPreviousHash !== undefined &&
    record.previousHash !== input.expectedPreviousHash
  )
    return {
      ok: false,
      code: "CHAIN_MISMATCH",
      reason: "previousHash does not match expected predecessor",
    }
  if (input.expectedKeyHash !== undefined) {
    const actualKeyHash = createHash("sha256").update(secretBytes).digest("hex")
    if (
      !isSha256Hex(input.expectedKeyHash) ||
      !timingSafeHexEqual(actualKeyHash, input.expectedKeyHash)
    )
      return { ok: false, code: "KEY_MISMATCH", reason: "secret does not match expected key hash" }
  }
  const unsigned = {
    version: record.version,
    sequence: record.sequence,
    previousHash: record.previousHash,
    payload: record.payload,
  }
  // Inspect the exact serialized bytes covered by the hash. In-memory values
  // can have custom serialization; a field omitted by it is not signed.
  let canonicalUnsigned: string
  let snapshot: SupervisorReceiptUnsigned
  try {
    canonicalUnsigned = canonicalizeSupervisorReceipt(unsigned)
    snapshot = JSON.parse(canonicalUnsigned) as SupervisorReceiptUnsigned
  } catch {
    return { ok: false, code: "INVALID_PAYLOAD", reason: "receipt payload is not serializable" }
  }
  const serializedInstance = payloadInstanceId(snapshot.payload)
  if (!serializedInstance)
    return { ok: false, code: "MISSING_INSTANCE", reason: "signed payload carries no instance id" }
  if (serializedInstance !== instanceId)
    return { ok: false, code: "INSTANCE_MISMATCH", reason: "serialized instance id changed" }
  const expectedHash = sha256Hex(canonicalUnsigned)
  if (!timingSafeHexEqual(expectedHash, record.hash))
    return { ok: false, code: "HASH_MISMATCH", reason: "receipt hash does not match payload" }
  const expectedSignature = createHmac("sha256", secretBytes)
    .update(canonicalizeSupervisorReceipt(snapshot, record.hash), "utf8")
    .digest("hex")
  if (!timingSafeHexEqual(expectedSignature, record.signature))
    return { ok: false, code: "SIGNATURE_MISMATCH", reason: "receipt signature is invalid" }
  return { ok: true, sequence: record.sequence, supervisorInstanceId: instanceId }
}
