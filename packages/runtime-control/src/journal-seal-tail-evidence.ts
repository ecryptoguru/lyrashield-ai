import { createHmac } from "node:crypto"
import { canonicalJson } from "./canonical-json"
import type { AuthorityEvent, BoundedConditionalObjectStore } from "./independent-journal"
import type { JournalRecord } from "./journal-record"

interface TailEvidenceOptions<T> {
  epochId: string
  supervisorInstanceId: string
  signingSecret: string
  store: Pick<BoundedConditionalObjectStore, "readBounded">
  mirror: {
    readRecordBounded?(sequence: number, maxBytes: number): Promise<JournalRecord<unknown> | null>
  }
  authorize: (record: JournalRecord<AuthorityEvent<JournalRecord<T>>>) => Promise<boolean>
  assertActive: () => void
}
function sign(secret: string, value: unknown): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
}

/** Check every selected tail record, its independently mirrored bytes and its observed ACK. */
export async function verifyJournalTailEvidence<T>(
  records: JournalRecord<AuthorityEvent<JournalRecord<T>>>[],
  options: TailEvidenceOptions<T>
): Promise<void> {
  if (!options.mirror.readRecordBounded || records.length > 32)
    throw new Error("bounded independent tail evidence is unavailable")
  const prefix = `epochs/${options.epochId}/supervisors/${options.supervisorInstanceId}`
  for (const record of records) {
    options.assertActive()
    if (record.payload.epochId !== options.epochId)
      throw new Error("journal tail belongs to a different epoch")
    const { epochId, operationId, scanId, workspaceId, attemptId, eventId } = record.payload
    const headBody = {
      schema: "lyrashield-independent-authority-head/1" as const,
      supervisorInstanceId: options.supervisorInstanceId,
      epochId,
      operationId,
      scanId,
      workspaceId,
      attemptId,
      eventId,
      sequence: record.sequence,
      previousHash: record.previousHash,
      recordHash: record.hash,
    }
    const head = { ...headBody, signature: sign(options.signingSecret, headBody) }
    const ackBody = { schema: "lyrashield-supervisor-observed-mirror-ack/1" as const, head }
    const ack = Buffer.from(
      canonicalJson({ ...ackBody, signature: sign(options.signingSecret, ackBody) })
    )
    const remoteBody = {
      schema: "lyrashield-independent-authority-record/1" as const,
      supervisorInstanceId: options.supervisorInstanceId,
      record,
    }
    const remote = Buffer.from(
      canonicalJson({ ...remoteBody, signature: sign(options.signingSecret, remoteBody) })
    )
    const mirrorSize = Buffer.byteLength(canonicalJson(record))
    const [object, mirrored, observed] = await Promise.all([
      options.store.readBounded(`${prefix}/records/${record.sequence}`, remote.byteLength),
      options.mirror.readRecordBounded(record.sequence, mirrorSize),
      options.store.readBounded(`${prefix}/acknowledgements/${record.sequence}`, ack.byteLength),
    ])
    options.assertActive()
    if (
      !object ||
      !mirrored ||
      !observed ||
      !Buffer.from(object.bytes).equals(remote) ||
      canonicalJson(mirrored) !== canonicalJson(record) ||
      !Buffer.from(observed.bytes).equals(ack)
    )
      throw new Error("independent journal tail record or acknowledgement is unavailable")
    if (!(await options.authorize(record)))
      throw new Error("current journal tail authority is unavailable")
    options.assertActive()
  }
}
