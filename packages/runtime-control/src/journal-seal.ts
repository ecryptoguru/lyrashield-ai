import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"
import type { AuthorityHead } from "./independent-journal"

const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const sequence = z.number().int().positive().safe()
const genesis = "0".repeat(64)
const bodyFields = {
  schema: z.literal("lyrashield-journal-seal/1"),
  epochId: id,
  supervisorInstanceId: id,
  revision: sequence,
  firstSequence: sequence,
  lastSequence: sequence,
  previousSealHash: hash,
  originalPreviousHash: hash,
  originalLastHash: hash,
  wrapperPreviousHash: hash,
  wrapperLastHash: hash,
  originalSegmentSha256: hash,
  wrapperSegmentSha256: hash,
  originalBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
  wrapperBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
  recordCount: z.number().int().min(1).max(32),
  independentHeadHash: hash,
  observedJournalAckHash: hash,
}
const v2BodyFields = {
  ...bodyFields,
  schema: z.literal("lyrashield-journal-seal/2"),
  originalSegmentStartSequence: sequence,
  originalByteOffset: z
    .number()
    .int()
    .positive()
    .safe()
    .max(64 * 1024 * 1024),
  wrapperSegmentStartSequence: sequence,
  wrapperByteOffset: z
    .number()
    .int()
    .positive()
    .safe()
    .max(64 * 1024 * 1024),
  recoverySnapshotSha256: hash,
  recoverySnapshotBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
}
type RangeFields = Pick<
  z.infer<z.ZodObject<typeof bodyFields>>,
  | "firstSequence"
  | "lastSequence"
  | "recordCount"
  | "revision"
  | "previousSealHash"
  | "originalPreviousHash"
  | "wrapperPreviousHash"
>
function validRange(value: RangeFields) {
  const first = value.firstSequence === 1
  return (
    value.lastSequence - value.firstSequence + 1 === value.recordCount &&
    (first ? value.revision === 1 : value.revision > 1) &&
    [value.previousSealHash, value.originalPreviousHash, value.wrapperPreviousHash].every((item) =>
      first ? item === genesis : item !== genesis
    )
  )
}
function validPositions(value: z.infer<z.ZodObject<typeof v2BodyFields>>) {
  return (
    value.originalSegmentStartSequence <= value.lastSequence &&
    value.wrapperSegmentStartSequence <= value.lastSequence
  )
}
const v1BodySchema = z.object(bodyFields).strict().refine(validRange)
const v2BodySchema = z.object(v2BodyFields).strict().refine(validRange).refine(validPositions)
export const journalSealBodySchema = z.union([v1BodySchema, v2BodySchema])
const v1SealSchema = z
  .object({ ...bodyFields, sealHash: hash, signature: hash })
  .strict()
  .refine(validRange)
export const journalSealV2Schema = z
  .object({ ...v2BodyFields, sealHash: hash, signature: hash })
  .strict()
  .refine(validRange)
  .refine(validPositions)
export const journalSealSchema = z.union([v1SealSchema, journalSealV2Schema])
export type JournalSeal = z.infer<typeof journalSealSchema>
export type JournalSealV2 = z.infer<typeof journalSealV2Schema>
export type JournalSealBody = z.infer<typeof journalSealBodySchema>
export interface JournalSealEvidence {
  seal: JournalSeal
  journalHead: AuthorityHead
  journalObservedAck: Uint8Array
  sealObservedAck: Uint8Array
}
export interface JournalSealEvidenceReader {
  readCurrentSealEvidence(stream: {
    epochId: string
    supervisorInstanceId: string
  }): Promise<JournalSealEvidence | null>
  /** An anchor only; caller must verify the entire bounded tail under the live gate. */
  readSealAnchorForContinuation?(stream: {
    epochId: string
    supervisorInstanceId: string
  }): Promise<JournalSealEvidence | null>
}

function sign(secret: string, value: unknown): string {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("journal seal key is too short")
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"),
    b = Buffer.from(right, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}
export function createJournalSeal(input: JournalSealBody, secret: string): JournalSeal {
  const body = journalSealBodySchema.parse(input)
  const sealHash = sha256Hex(canonicalJson(body))
  return journalSealSchema.parse({
    ...body,
    sealHash,
    signature: sign(secret, { ...body, sealHash }),
  })
}
export function verifyJournalSeal(input: unknown, secret: string): JournalSeal {
  const seal = journalSealSchema.parse(input)
  const { sealHash, signature, ...body } = seal
  if (
    !equal(sealHash, sha256Hex(canonicalJson(body))) ||
    !equal(signature, sign(secret, { ...body, sealHash }))
  )
    throw new Error("journal seal signature or hash differs")
  return seal
}

export function verifyJournalSealForContinuation(input: unknown, secret: string): JournalSealV2 {
  return journalSealV2Schema.parse(verifyJournalSeal(input, secret))
}

const sealAckBodySchema = z
  .object({
    schema: z.literal("lyrashield-journal-seal-observed-mirror-ack/1"),
    epochId: id,
    supervisorInstanceId: id,
    revision: sequence,
    sealHash: hash,
  })
  .strict()
const sealAckSchema = sealAckBodySchema.extend({ signature: hash }).strict()
export type ObservedSealAck = z.infer<typeof sealAckSchema>

/** Call only after the mirror has positively acknowledged this exact seal. */
export function createObservedSealAck(seal: JournalSeal, secret: string): ObservedSealAck {
  const body = sealAckBodySchema.parse({
    schema: "lyrashield-journal-seal-observed-mirror-ack/1",
    epochId: seal.epochId,
    supervisorInstanceId: seal.supervisorInstanceId,
    revision: seal.revision,
    sealHash: seal.sealHash,
  })
  return { ...body, signature: sign(secret, body) }
}
export function verifyObservedSealAck(input: unknown, secret: string): ObservedSealAck {
  const ack = sealAckSchema.parse(input)
  const { signature, ...body } = ack
  if (!equal(signature, sign(secret, body)))
    throw new Error("journal seal acknowledgement signature differs")
  return ack
}
