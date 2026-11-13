import { createHash } from "node:crypto"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import {
  authorityEventSchema,
  type AuthorityEvent,
  type BoundedConditionalObjectStore,
} from "./independent-journal"
import { verifyJournalRecord, type JournalRecord } from "./journal-record"
import { verifyJournalSeal } from "./journal-seal"

interface ArchiveKeys<T> {
  originalSigningSecret: string
  wrapperSigningSecret: string
  sealSigningSecret: string
  validateOriginal: (value: unknown) => T
}
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
function lines(bytes: Uint8Array, count: number): unknown[] {
  const text = Buffer.from(bytes).toString("utf8")
  if (!Buffer.from(text).equals(Buffer.from(bytes)) || !text.endsWith("\n"))
    throw new Error("sealed archive has incomplete or invalid UTF-8 records")
  const rows = text.slice(0, -1).split("\n")
  if (rows.length !== count || rows.some((row) => !row))
    throw new Error("sealed archive record count differs")
  return rows.map((row) => JSON.parse(row) as unknown)
}

/** Checks archive bytes against a signed seal. Current stream authority is checked separately. */
export async function auditJournalSealArchives<T>(
  input: unknown,
  store: Pick<BoundedConditionalObjectStore, "readBounded">,
  keys: ArchiveKeys<T>
): Promise<{
  originals: JournalRecord<T>[]
  wrappers: JournalRecord<AuthorityEvent<JournalRecord<T>>>[]
}> {
  const seal = verifyJournalSeal(input, keys.sealSigningSecret)
  const prefix = `epochs/${seal.epochId}/supervisors/${seal.supervisorInstanceId}/seal-segments/${seal.sealHash}`
  const read = async () => {
    const [original, wrapper] = await Promise.all([
      store.readBounded(`${prefix}/original`, seal.originalBytes),
      store.readBounded(`${prefix}/wrapper`, seal.wrapperBytes),
    ])
    if (!original || !wrapper || !original.etag || !wrapper.etag)
      throw new Error("sealed journal archive is unavailable")
    if (
      original.bytes.byteLength !== seal.originalBytes ||
      wrapper.bytes.byteLength !== seal.wrapperBytes ||
      sha(original.bytes) !== seal.originalSegmentSha256 ||
      sha(wrapper.bytes) !== seal.wrapperSegmentSha256
    )
      throw new Error("sealed journal archive differs from commitment")
    return { original, wrapper }
  }
  const snapshot = await read()
  const originals = lines(snapshot.original.bytes, seal.recordCount).map((value) =>
    verifyJournalRecord(value, keys.originalSigningSecret, keys.validateOriginal)
  )
  const wrappers = lines(snapshot.wrapper.bytes, seal.recordCount).map((value) =>
    verifyJournalRecord(value, keys.wrapperSigningSecret, (input) => {
      const event = authorityEventSchema(z.unknown()).parse(input)
      const original = verifyJournalRecord(
        event.payload,
        keys.originalSigningSecret,
        keys.validateOriginal
      )
      return { ...event, payload: original }
    })
  )
  let previousOriginal = seal.originalPreviousHash
  let previousWrapper = seal.wrapperPreviousHash
  for (let index = 0; index < seal.recordCount; index += 1) {
    const original = originals[index]!,
      wrapper = wrappers[index]!
    if (
      original.sequence !== seal.firstSequence + index ||
      wrapper.sequence !== original.sequence ||
      original.previousHash !== previousOriginal ||
      wrapper.previousHash !== previousWrapper ||
      wrapper.payload.epochId !== seal.epochId ||
      canonicalJson(wrapper.payload.payload) !== canonicalJson(original)
    )
      throw new Error("sealed journal archive chain or stream differs")
    previousOriginal = original.hash
    previousWrapper = wrapper.hash
  }
  if (previousOriginal !== seal.originalLastHash || previousWrapper !== seal.wrapperLastHash)
    throw new Error("sealed journal archive endpoint differs")
  const rechecked = await read()
  if (
    snapshot.original.etag !== rechecked.original.etag ||
    snapshot.wrapper.etag !== rechecked.wrapper.etag ||
    !Buffer.from(snapshot.original.bytes).equals(Buffer.from(rechecked.original.bytes)) ||
    !Buffer.from(snapshot.wrapper.bytes).equals(Buffer.from(rechecked.wrapper.bytes))
  )
    throw new Error("sealed journal archive changed during audit")
  return { originals, wrappers }
}
