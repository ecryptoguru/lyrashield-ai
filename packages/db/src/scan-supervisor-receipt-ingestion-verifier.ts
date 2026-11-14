import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  authorityEventSchema,
  canonicalJson,
  headSchema,
  MAX_SUPERVISOR_JOURNAL_PAGE_BYTES,
  supervisorJournalCursorSchema,
  verifyJournalRecord,
  type AuthorityHead,
  type JournalRecord,
  type SupervisorJournalCursor,
  type SupervisorAttemptProofInput,
  type SupervisorAttemptProof,
} from "@lyrashield/runtime-control"
import { verifySupervisorReceiptHmac } from "./scan-supervisor-receipt-verifier"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

const eventSchema = z
  .object({
    type: z.string().min(1).max(64),
    supervisorInstanceId: z.string().min(3).max(192),
    observedAt: z.string().datetime({ offset: true }),
  })
  .passthrough()
export type IngestedSupervisorEvent = z.infer<typeof eventSchema>
const originalSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().safe(),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    payload: eventSchema,
  })
  .strict()
const wrappedSchema = authorityEventSchema(originalSchema)
export type IngestedSupervisorRecord = JournalRecord<z.infer<typeof wrappedSchema>>

/** Supplied only by the protected broker installation, never by an HTTP caller. */
export type SupervisorAttemptProofAuthority = Pick<
  SupervisorReceiptAuthority,
  "streamId" | "authorityEpochId" | "supervisorInstanceId" | "originalKeyHash" | "wrapperKeyHash"
> & {
  attemptProofPublicKey: string
  readAttemptProof(input: SupervisorAttemptProofInput): Promise<SupervisorAttemptProof>
}

export interface SupervisorReceiptAuthority {
  connectionString: string
  streamId: string
  authorityEpochId: string
  supervisorInstanceId: string
  originalSigningSecret: string
  originalKeyHash: string
  wrapperSigningSecret: string
  wrapperKeyHash: string
  readJournal(cursor: SupervisorJournalCursor): Promise<unknown>
  attemptProofPublicKey?: string
  readAttemptProof?(input: SupervisorAttemptProofInput): Promise<SupervisorAttemptProof>
}

export function receiptFailure(code: `SUPERVISOR_${string}`): never {
  throw new ScanDispatchAuthorityError(code, "Supervisor receipt authority is unavailable")
}

export function checkReceiptKeys(authority: SupervisorReceiptAuthority): void {
  for (const [secret, hash] of [
    [authority.originalSigningSecret, authority.originalKeyHash],
    [authority.wrapperSigningSecret, authority.wrapperKeyHash],
  ]) {
    if (Buffer.byteLength(secret!) < 32 || !/^[a-f0-9]{64}$/.test(hash!))
      receiptFailure("SUPERVISOR_KEY_UNAVAILABLE")
    const actual = createHash("sha256").update(secret!).digest("hex")
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(hash!)))
      receiptFailure("SUPERVISOR_KEY_MISMATCH")
  }
}

export function verifyHead(value: unknown, authority: SupervisorReceiptAuthority): AuthorityHead {
  const head = headSchema.parse(value)
  const { signature, ...unsigned } = head
  const expected = createHmac("sha256", authority.wrapperSigningSecret)
    .update(canonicalJson(unsigned))
    .digest("hex")
  if (
    head.epochId !== authority.authorityEpochId ||
    head.supervisorInstanceId !== authority.supervisorInstanceId ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    receiptFailure("SUPERVISOR_HEAD_MISMATCH")
  return head
}

export function verifyReceiptPage(
  input: unknown,
  authority: SupervisorReceiptAuthority,
  cursor: SupervisorJournalCursor,
  previousWrapperHash: string,
  snapshot: AuthorityHead | null | undefined
) {
  // Work only on the authenticated JSON snapshot, never caller-owned getters.
  const inputJson = canonicalJson(input)
  if (Buffer.byteLength(inputJson) > MAX_SUPERVISOR_JOURNAL_PAGE_BYTES)
    receiptFailure("SUPERVISOR_PAGE_TOO_LARGE")
  const page = z
    .object({
      records: z.array(z.unknown()).max(cursor.limit),
      nextCursor: supervisorJournalCursorSchema,
      snapshotHead: z.unknown().nullable(),
      hasMore: z.boolean(),
    })
    .strict()
    .parse(JSON.parse(inputJson))
  const head = page.snapshotHead === null ? null : verifyHead(page.snapshotHead, authority)
  if (snapshot !== undefined && canonicalJson(head) !== canonicalJson(snapshot))
    receiptFailure("SUPERVISOR_SNAPSHOT_CHANGED")
  let sequence = cursor.afterSequence
  let originalHash = cursor.afterHash
  let wrapperHash = previousWrapperHash
  const records: IngestedSupervisorRecord[] = []
  for (const value of page.records) {
    const record = verifyJournalRecord(value, authority.wrapperSigningSecret, wrappedSchema.parse)
    const original = record.payload.payload
    const verified = verifySupervisorReceiptHmac({
      record: original,
      expectedInstanceId: authority.supervisorInstanceId,
      secret: authority.originalSigningSecret,
      expectedKeyHash: authority.originalKeyHash,
      expectedSequence: sequence + 1,
      expectedPreviousHash: originalHash,
    })
    if (
      !verified.ok ||
      record.sequence !== sequence + 1 ||
      record.previousHash !== wrapperHash ||
      record.payload.epochId !== authority.authorityEpochId ||
      record.payload.eventId !== `supervisor:${original.hash}`
    )
      receiptFailure("SUPERVISOR_RECORD_MISMATCH")
    sequence = record.sequence
    originalHash = original.hash
    wrapperHash = record.hash
    records.push(record)
  }
  const next = page.nextCursor
  if (
    next.epochId !== authority.authorityEpochId ||
    next.supervisorInstanceId !== authority.supervisorInstanceId ||
    next.afterSequence !== sequence ||
    next.afterHash !== originalHash ||
    next.limit !== cursor.limit ||
    next.snapshotSequence !== (head?.sequence ?? 0) ||
    next.snapshotHash !== (head?.recordHash ?? "0".repeat(64)) ||
    sequence > (head?.sequence ?? 0) ||
    page.hasMore !== sequence < (head?.sequence ?? 0) ||
    (page.hasMore && !records.length) ||
    (!page.hasMore && wrapperHash !== (head?.recordHash ?? "0".repeat(64)))
  )
    receiptFailure("SUPERVISOR_CURSOR_MISMATCH")
  const last = records.at(-1)
  if (
    !page.hasMore &&
    last &&
    head &&
    (head.eventId !== last.payload.eventId ||
      head.operationId !== last.payload.operationId ||
      head.scanId !== last.payload.scanId ||
      head.workspaceId !== last.payload.workspaceId ||
      head.attemptId !== last.payload.attemptId ||
      head.previousHash !== last.previousHash)
  )
    receiptFailure("SUPERVISOR_HEAD_BINDING_MISMATCH")
  return { records, nextCursor: next, head, hasMore: page.hasMore, wrapperHash }
}
