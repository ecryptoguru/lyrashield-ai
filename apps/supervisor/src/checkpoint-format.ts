import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  IndependentAuthorityError,
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  verifyJournalRecord,
  type AuthorityEvent,
  type JournalRecord,
} from "@lyrashield/runtime-control"
import { supervisorJournalEventSchema, type SupervisorJournalEvent } from "./journal-events"

export const CHECKPOINT_LIMITS = {
  records: 32,
  segmentBytes: 1024 * 1024,
  recordBytes: 256 * 1024,
  metadataBytes: 16 * 1024,
  localHeadBytes: 512 * 1024,
} as const
export const CHECKPOINT_GENESIS = "0".repeat(64)
const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const sequence = z.number().int().positive().safe()
export const checkpointBodySchema = z
  .object({
    schema: z.literal("lyrashield-supervisor-checkpoint/1"),
    epochId: id,
    supervisorInstanceId: id,
    firstSequence: sequence,
    lastSequence: sequence,
    originalPreviousHash: hash,
    wrapperPreviousHash: hash,
    originalLastHash: hash,
    wrapperLastHash: hash,
    previousCheckpointHash: hash,
    recordsHash: hash,
  })
  .strict()
  .refine(
    (value) =>
      value.lastSequence >= value.firstSequence &&
      value.lastSequence - value.firstSequence < CHECKPOINT_LIMITS.records
  )
const signedCheckpointSchema = z
  .object({
    schema: z.literal("lyrashield-supervisor-checkpoint/1"),
    epochId: id,
    supervisorInstanceId: id,
    firstSequence: sequence,
    lastSequence: sequence,
    originalPreviousHash: hash,
    wrapperPreviousHash: hash,
    originalLastHash: hash,
    wrapperLastHash: hash,
    previousCheckpointHash: hash,
    recordsHash: hash,
    checkpointHash: hash,
    signature: hash,
  })
  .strict()
export type SupervisorCheckpoint = z.infer<typeof signedCheckpointSchema>
export type CheckpointOriginal = JournalRecord<SupervisorJournalEvent>
export type CheckpointRecord = JournalRecord<AuthorityEvent<CheckpointOriginal>>
export interface CheckpointKeys {
  originalSigningSecret: string
  wrapperSigningSecret: string
  checkpointSigningSecret: string
}
export interface CheckpointCandidate {
  checkpoint: SupervisorCheckpoint
  bytes: Uint8Array
}

export function checkpointFailure(code: string, message: string): never {
  throw new IndependentAuthorityError(code, message)
}
export function checkpointSame(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
export function checkpointSign(secret: string, value: unknown): string {
  if (Buffer.byteLength(secret) < 32) throw new Error("checkpoint signing secret requires 32 bytes")
  return createHmac("sha256", secret).update(canonicalJson(value), "utf8").digest("hex")
}
function equalSignature(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function verifyCheckpoint(value: unknown, secret: string): SupervisorCheckpoint {
  const checkpoint = signedCheckpointSchema.parse(value)
  const { checkpointHash, signature, ...body } = checkpoint
  checkpointBodySchema.parse(body)
  if (
    checkpointHash !== sha256Hex(canonicalJson(body)) ||
    !equalSignature(signature, checkpointSign(secret, { ...body, checkpointHash }))
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint signature or digest differs")
  if (
    checkpoint.firstSequence === 1 &&
    [
      checkpoint.originalPreviousHash,
      checkpoint.wrapperPreviousHash,
      checkpoint.previousCheckpointHash,
    ].some((value) => value !== CHECKPOINT_GENESIS)
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint genesis differs")
  if (
    checkpoint.firstSequence > 1 &&
    [
      checkpoint.originalPreviousHash,
      checkpoint.wrapperPreviousHash,
      checkpoint.previousCheckpointHash,
    ].some((value) => value === CHECKPOINT_GENESIS)
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint predecessor anchor is unavailable")
  return checkpoint
}

const originalEnvelopeSchema = z
  .object({
    version: z.literal(1),
    sequence,
    previousHash: hash,
    hash,
    signature: hash,
    payload: supervisorJournalEventSchema,
  })
  .strict()
export function verifyCheckpointRecord(value: unknown, keys: CheckpointKeys): CheckpointRecord {
  if (Buffer.byteLength(canonicalJson(value)) > CHECKPOINT_LIMITS.recordBytes)
    checkpointFailure("READ_LIMIT", "checkpoint record exceeds limit")
  const record = verifyJournalRecord(value, keys.wrapperSigningSecret, (value) =>
    authorityEventSchema(originalEnvelopeSchema).parse(value)
  )
  if (!checkpointSame(record, value))
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint envelope changed during validation")
  const original = verifyJournalRecord(
    record.payload.payload,
    keys.originalSigningSecret,
    (value) => supervisorJournalEventSchema.parse(value)
  )
  const event = original.payload
  const attemptId =
    event.type === "command_intent"
      ? event.command.type === "PREPARE"
        ? event.command.attempt.attemptId
        : event.command.attemptId
      : event.type === "attempt_prepared"
        ? event.binding.attemptId
        : event.attemptId
  if (
    record.sequence !== original.sequence ||
    record.payload.attemptId !== attemptId ||
    record.payload.eventId !== `supervisor:${original.hash}`
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "wrapper differs from original event identity")
  const binding =
    event.type === "attempt_prepared"
      ? event.binding
      : event.type === "command_intent" && event.command.type === "PREPARE"
        ? event.command.attempt
        : null
  if (
    binding &&
    (binding.authorityEpochId !== record.payload.epochId ||
      binding.operationId !== record.payload.operationId ||
      binding.scanId !== record.payload.scanId ||
      binding.workspaceId !== record.payload.workspaceId)
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "wrapper differs from original attempt binding")
  return record
}

export function verifyCheckpointSegment(
  bytes: Uint8Array,
  checkpoint: SupervisorCheckpoint,
  keys: CheckpointKeys
): CheckpointRecord[] {
  if (bytes.byteLength > CHECKPOINT_LIMITS.segmentBytes)
    checkpointFailure("READ_LIMIT", "checkpoint segment exceeds limit")
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"))
  if (
    !Array.isArray(parsed) ||
    parsed.length !== checkpoint.lastSequence - checkpoint.firstSequence + 1
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint segment count differs")
  if (sha256Hex(canonicalJson(parsed)) !== checkpoint.recordsHash)
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint segment digest differs")
  let originalHash = checkpoint.originalPreviousHash,
    wrapperHash = checkpoint.wrapperPreviousHash
  const records = parsed.map((value, index) => {
    const record = verifyCheckpointRecord(value, keys),
      original = record.payload.payload
    if (
      record.sequence !== checkpoint.firstSequence + index ||
      record.previousHash !== wrapperHash ||
      original.previousHash !== originalHash ||
      record.payload.epochId !== checkpoint.epochId ||
      original.payload.supervisorInstanceId !== checkpoint.supervisorInstanceId
    )
      checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint segment chain or stream differs")
    originalHash = original.hash
    wrapperHash = record.hash
    return record
  })
  if (originalHash !== checkpoint.originalLastHash || wrapperHash !== checkpoint.wrapperLastHash)
    checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint segment end differs")
  return records
}

/** Build an unpublished candidate only. Publication must independently confirm all histories and authority. */
export function buildCheckpointCandidate(
  records: CheckpointRecord[],
  previous: SupervisorCheckpoint | null,
  stream: { epochId: string; supervisorInstanceId: string },
  keys: CheckpointKeys
): CheckpointCandidate {
  if (!records.length || records.length > CHECKPOINT_LIMITS.records)
    checkpointFailure("READ_LIMIT", "invalid checkpoint segment count")
  const prior = previous ? verifyCheckpoint(previous, keys.checkpointSigningSecret) : null
  const first = records[0]!,
    last = records.at(-1)!
  if (
    first.sequence !== (prior?.lastSequence ?? 0) + 1 ||
    first.previousHash !== (prior?.wrapperLastHash ?? CHECKPOINT_GENESIS) ||
    first.payload.payload.previousHash !== (prior?.originalLastHash ?? CHECKPOINT_GENESIS) ||
    (prior &&
      (prior.epochId !== stream.epochId ||
        prior.supervisorInstanceId !== stream.supervisorInstanceId))
  )
    checkpointFailure(
      "CHECKPOINT_CONFLICT",
      "checkpoint candidate does not extend its exact predecessor"
    )
  const bytes = Buffer.from(canonicalJson(records), "utf8")
  const body = checkpointBodySchema.parse({
    schema: "lyrashield-supervisor-checkpoint/1",
    ...stream,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    originalPreviousHash: first.payload.payload.previousHash,
    wrapperPreviousHash: first.previousHash,
    originalLastHash: last.payload.payload.hash,
    wrapperLastHash: last.hash,
    previousCheckpointHash: prior?.checkpointHash ?? CHECKPOINT_GENESIS,
    recordsHash: sha256Hex(canonicalJson(records)),
  })
  const checkpointHash = sha256Hex(canonicalJson(body))
  const checkpoint = {
    ...body,
    checkpointHash,
    signature: checkpointSign(keys.checkpointSigningSecret, { ...body, checkpointHash }),
  }
  verifyCheckpointSegment(bytes, checkpoint, keys)
  return { checkpoint, bytes }
}
