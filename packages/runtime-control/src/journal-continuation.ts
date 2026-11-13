import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"
import {
  IndependentAuthorityError,
  authorityEventSchema,
  type AuthorityEvent,
  type AuthorityHead,
} from "./independent-journal"
import { verifyJournalRecord, type JournalRecord } from "./journal-record"
import { journalSealV2Schema, type JournalSealV2 } from "./journal-seal"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import { readSignedJournalTail, type VerifiedJournalTail } from "./journal-tail"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"

export interface JournalContinuationOptions<T> {
  stream: { epochId: string; supervisorInstanceId: string }
  pin: ProtectedJournalSealPinStore
  evidence: StoredJournalSealEvidenceReader<T>
  originalPath: string
  wrapperPath: string
  originalSigningSecret: string
  wrapperSigningSecret: string
  sealSigningSecret: string
  validateOriginal: (value: unknown) => T
  authorize: (record: JournalRecord<AuthorityEvent<JournalRecord<T>>>) => Promise<boolean>
}
export interface VerifiedJournalContinuation<T> {
  sealed: JournalSealV2
  journalHead: AuthorityHead
  sealedRecords: {
    originals: JournalRecord<T>[]
    wrappers: JournalRecord<AuthorityEvent<JournalRecord<T>>>[]
  }
  originalTail: VerifiedJournalTail<T>
  wrapperTail: VerifiedJournalTail<AuthorityEvent<JournalRecord<T>>>
  assertActive: () => void
}
const LIMITS = { maxRecords: 32, maxBytes: 1024 * 1024 }

async function readTails<T>(
  options: JournalContinuationOptions<T>,
  seal: JournalSealV2,
  head: AuthorityHead,
  assertActive: () => void
): Promise<VerifiedJournalContinuation<T>> {
  const wrapperTail = await readSignedJournalTail(
    options.wrapperPath,
    options.wrapperSigningSecret,
    (value) => {
      const event = authorityEventSchema(z.unknown()).parse(value)
      return {
        ...event,
        payload: verifyJournalRecord(
          event.payload,
          options.originalSigningSecret,
          options.validateOriginal
        ),
      }
    },
    {
      position: {
        segmentStartSequence: seal.wrapperSegmentStartSequence,
        byteOffsetAfterLastSealedRecord: seal.wrapperByteOffset,
      },
      afterSequence: seal.lastSequence,
      afterHash: seal.wrapperLastHash,
      expectedSequence: head.sequence,
      expectedHash: head.recordHash,
      ...LIMITS,
    }
  )
  const originalHead = wrapperTail.records.at(-1)?.payload.payload.hash ?? seal.originalLastHash
  const originalTail = await readSignedJournalTail(
    options.originalPath,
    options.originalSigningSecret,
    options.validateOriginal,
    {
      position: {
        segmentStartSequence: seal.originalSegmentStartSequence,
        byteOffsetAfterLastSealedRecord: seal.originalByteOffset,
      },
      afterSequence: seal.lastSequence,
      afterHash: seal.originalLastHash,
      expectedSequence: head.sequence,
      expectedHash: originalHead,
      ...LIMITS,
    }
  )
  if (originalTail.hasUnconfirmedSuffix || wrapperTail.hasUnconfirmedSuffix)
    throw new IndependentAuthorityError("REPLAY_REQUIRED", "journal contains an unconfirmed suffix")
  if (
    originalTail.records.length !== wrapperTail.records.length ||
    originalTail.records.some(
      (record, index) =>
        canonicalJson(record) !== canonicalJson(wrapperTail.records[index]?.payload.payload)
    )
  )
    throw new IndependentAuthorityError(
      "AUTHORITY_UNKNOWN",
      "original and independent journal tails differ"
    )
  await options.evidence.verifyTailRecords(wrapperTail.records, options.authorize, assertActive)
  const sealedRecords = await options.evidence.readSealedRecords(seal)
  assertActive()
  return { sealed: seal, journalHead: head, sealedRecords, originalTail, wrapperTail, assertActive }
}

/**
 * Verify a bounded suffix under the protected pin gate. The callback must only
 * compute recovery state; this does not authorize physical or external actions.
 */
export async function withVerifiedJournalContinuation<T, R>(
  options: JournalContinuationOptions<T>,
  action: (state: VerifiedJournalContinuation<T>) => Promise<R>
): Promise<R> {
  if (
    !(options.pin instanceof ProtectedJournalSealPinStore) ||
    !(options.evidence instanceof StoredJournalSealEvidenceReader)
  )
    throw new Error("protected journal continuation is unavailable")
  options.pin.assertEvidenceReader(options.evidence)
  options.evidence.assertInstalledStream({
    ...options.stream,
    originalKeyHash: sha256Hex(options.originalSigningSecret),
    wrapperKeyHash: sha256Hex(options.wrapperSigningSecret),
    checkpointKeyHash: sha256Hex(options.sealSigningSecret),
  })
  return options.pin.withBoundedContinuation(options.stream, async (anchor) => {
    const seal = journalSealV2Schema.parse(anchor.seal)
    const read = () => readTails(options, seal, anchor.journalHead, anchor.assertActive)
    const before = await read()
    const result = await action({
      sealed: structuredClone(before.sealed),
      journalHead: structuredClone(before.journalHead),
      sealedRecords: structuredClone(before.sealedRecords),
      originalTail: structuredClone(before.originalTail),
      wrapperTail: structuredClone(before.wrapperTail),
      assertActive: before.assertActive,
    })
    const after = await read()
    const current = await options.evidence.readSealAnchorForContinuation(options.stream)
    if (
      !current ||
      canonicalJson(current.seal) !== canonicalJson(seal) ||
      canonicalJson(current.journalHead) !== canonicalJson(anchor.journalHead) ||
      canonicalJson(before.sealedRecords) !== canonicalJson(after.sealedRecords) ||
      canonicalJson(before.originalTail) !== canonicalJson(after.originalTail) ||
      canonicalJson(before.wrapperTail) !== canonicalJson(after.wrapperTail)
    )
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "journal continuation changed during recovery"
      )
    anchor.assertActive()
    return result
  })
}
