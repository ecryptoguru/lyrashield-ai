import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import {
  headSchema,
  type AuthorityEvent,
  type AuthorityHead,
  type BoundedConditionalObjectStore,
} from "./independent-journal"
import {
  verifyJournalSeal,
  verifyObservedSealAck,
  type JournalSeal,
  type JournalSealEvidence,
  type JournalSealEvidenceReader,
} from "./journal-seal"
import { auditJournalSealArchives } from "./journal-seal-archive"
import { verifyJournalTailEvidence } from "./journal-seal-tail-evidence"
import type { JournalRecord } from "./journal-record"

const LIMIT = 16 * 1024
const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const streamSchema = z.object({ epochId: id, supervisorInstanceId: id }).strict()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const journalAckSchema = z
  .object({
    schema: z.literal("lyrashield-supervisor-observed-mirror-ack/1"),
    head: headSchema,
    signature: hash,
  })
  .strict()
interface SealMirrorReader {
  readHeadBounded(maxBytes: number): Promise<AuthorityHead | null>
  readSealHeadBounded(maxBytes: number): Promise<JournalSeal | null>
  readSealBounded(revision: number, maxBytes: number): Promise<JournalSeal | null>
  readRecordBounded?(sequence: number, maxBytes: number): Promise<JournalRecord<unknown> | null>
}
interface SealSnapshot {
  seal: JournalSeal
  head: AuthorityHead
  sealEtag: string
  headEtag: string
  sealedHeadEtag: string | null
}
interface ReaderOptions<T> {
  epochId: string
  supervisorInstanceId: string
  store: Pick<BoundedConditionalObjectStore, "readBounded">
  mirror: SealMirrorReader
  headSigningSecret: string
  sealSigningSecret: string
  originalSigningSecret: string
  wrapperSigningSecret: string
  validateOriginal: (value: unknown) => T
}
function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
function signature(secret: string, value: unknown): string {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("journal evidence key is too short")
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function parseCanonical(bytes: Uint8Array): unknown {
  if (bytes.byteLength > LIMIT) throw new Error("journal seal evidence exceeds read limit")
  const text = Buffer.from(bytes).toString("utf8")
  const value: unknown = JSON.parse(text)
  if (!Buffer.from(canonicalJson(value)).equals(Buffer.from(bytes)))
    throw new Error("journal seal evidence is not canonical")
  return value
}
function verifyHead(
  value: unknown,
  secret: string,
  stream: z.infer<typeof streamSchema>
): AuthorityHead {
  const head = headSchema.parse(value)
  const { signature: actual, ...body } = head
  if (
    !equal(actual, signature(secret, body)) ||
    head.epochId !== stream.epochId ||
    head.supervisorInstanceId !== stream.supervisorInstanceId
  )
    throw new Error("independent journal head is unauthenticated")
  return head
}

/** Reads independent protected stores only. It does not authorize the stream or pin updates. */
export class StoredJournalSealEvidenceReader<T = unknown> implements JournalSealEvidenceReader {
  private readonly stream: z.infer<typeof streamSchema>
  private readonly prefix: string
  private readonly options: Readonly<ReaderOptions<T>>
  constructor(options: ReaderOptions<T>) {
    this.options = Object.freeze({ ...options })
    this.stream = streamSchema.parse({
      epochId: options.epochId,
      supervisorInstanceId: options.supervisorInstanceId,
    })
    this.prefix = `epochs/${this.stream.epochId}/supervisors/${this.stream.supervisorInstanceId}`
    signature(options.headSigningSecret, {})
    signature(options.sealSigningSecret, {})
    signature(options.originalSigningSecret, {})
    signature(options.wrapperSigningSecret, {})
  }

  assertInstalledStream(input: {
    epochId: string
    supervisorInstanceId: string
    originalKeyHash: string
    wrapperKeyHash: string
    checkpointKeyHash: string
  }): void {
    const expected = z
      .object({
        ...streamSchema.shape,
        originalKeyHash: hash,
        wrapperKeyHash: hash,
        checkpointKeyHash: hash,
      })
      .strict()
      .parse(input)
    const keyHash = (value: string) => digest(Buffer.from(value, "utf8"))
    if (
      expected.epochId !== this.stream.epochId ||
      expected.supervisorInstanceId !== this.stream.supervisorInstanceId ||
      !equal(expected.originalKeyHash, keyHash(this.options.originalSigningSecret)) ||
      !equal(expected.wrapperKeyHash, keyHash(this.options.wrapperSigningSecret)) ||
      !equal(expected.wrapperKeyHash, keyHash(this.options.headSigningSecret)) ||
      !equal(expected.checkpointKeyHash, keyHash(this.options.sealSigningSecret))
    )
      throw new Error("journal seal reader differs from installed stream or keys")
  }

  async readCurrentSealEvidence(input: {
    epochId: string
    supervisorInstanceId: string
  }): Promise<JournalSealEvidence | null> {
    return this.readEvidence(input, false)
  }

  async verifyTailRecords(
    records: JournalRecord<AuthorityEvent<JournalRecord<T>>>[],
    authorize: (record: JournalRecord<AuthorityEvent<JournalRecord<T>>>) => Promise<boolean>,
    assertActive: () => void
  ): Promise<void> {
    await verifyJournalTailEvidence(records, {
      ...this.stream,
      signingSecret: this.options.headSigningSecret,
      store: this.options.store,
      mirror: this.options.mirror,
      authorize,
      assertActive,
    })
  }

  /** The caller must first bind this seal to the held protected pin. */
  async readSealedRecords(seal: JournalSeal) {
    return auditJournalSealArchives(seal, this.options.store, {
      originalSigningSecret: this.options.originalSigningSecret,
      wrapperSigningSecret: this.options.wrapperSigningSecret,
      sealSigningSecret: this.options.sealSigningSecret,
      validateOriginal: this.options.validateOriginal,
    })
  }

  /** Returns only a signed v2 anchor; the caller must verify the complete current tail. */
  async readSealAnchorForContinuation(input: {
    epochId: string
    supervisorInstanceId: string
  }): Promise<JournalSealEvidence | null> {
    return this.readEvidence(input, true)
  }

  private async readHeads(
    stream: z.infer<typeof streamSchema>,
    allowNewerHead: boolean
  ): Promise<SealSnapshot | null> {
    const [objectSeal, mirrorSeal, objectHead, mirrorHead] = await Promise.all([
      this.options.store.readBounded(`${this.prefix}/seal-head`, LIMIT),
      this.options.mirror.readSealHeadBounded(LIMIT),
      this.options.store.readBounded(`${this.prefix}/head`, LIMIT),
      this.options.mirror.readHeadBounded(LIMIT),
    ])
    if (!objectSeal && !mirrorSeal) return null
    if (
      !objectSeal ||
      !mirrorSeal ||
      !objectHead ||
      !mirrorHead ||
      !objectSeal.etag ||
      !objectHead.etag
    )
      throw new Error("journal seal or independent head is unavailable")
    const seal = verifyJournalSeal(parseCanonical(objectSeal.bytes), this.options.sealSigningSecret)
    const pgSeal = verifyJournalSeal(mirrorSeal, this.options.sealSigningSecret)
    const head = verifyHead(
      parseCanonical(objectHead.bytes),
      this.options.headSigningSecret,
      stream
    )
    const pgHead = verifyHead(mirrorHead, this.options.headSigningSecret, stream)
    if (
      seal.epochId !== stream.epochId ||
      seal.supervisorInstanceId !== stream.supervisorInstanceId ||
      canonicalJson(seal) !== canonicalJson(pgSeal) ||
      canonicalJson(head) !== canonicalJson(pgHead) ||
      head.sequence < seal.lastSequence
    )
      throw new Error("journal seal and independent heads disagree")
    let sealedHeadEtag: string | null = null
    if (seal.schema === "lyrashield-journal-seal/2") {
      const archived = await this.options.store.readBounded(
        `${this.prefix}/seal-journal-heads/${seal.independentHeadHash}`,
        LIMIT
      )
      if (!archived || !archived.etag || digest(archived.bytes) !== seal.independentHeadHash)
        throw new Error("sealed journal head is unavailable")
      const sealedHead = verifyHead(
        parseCanonical(archived.bytes),
        this.options.headSigningSecret,
        stream
      )
      if (
        sealedHead.sequence < seal.lastSequence ||
        head.sequence < sealedHead.sequence ||
        (head.sequence === sealedHead.sequence &&
          canonicalJson(head) !== canonicalJson(sealedHead)) ||
        (!allowNewerHead && canonicalJson(head) !== canonicalJson(sealedHead))
      )
        throw new Error("current journal head differs from sealed head")
      sealedHeadEtag = archived.etag
    } else if (
      allowNewerHead ||
      seal.independentHeadHash !== digest(Buffer.from(canonicalJson(head)))
    ) {
      throw new Error("v1 seal cannot anchor bounded continuation")
    }
    return { seal, head, sealEtag: objectSeal.etag, headEtag: objectHead.etag, sealedHeadEtag }
  }

  private async readObjects(first: SealSnapshot, stream: z.infer<typeof streamSchema>) {
    const [
      sealObject,
      journalAckObject,
      sealAckObject,
      originalArchive,
      wrapperArchive,
      mirroredSeal,
      recoverySnapshot,
    ] = await Promise.all([
      this.options.store.readBounded(`${this.prefix}/seals/${first.seal.sealHash}`, LIMIT),
      this.options.store.readBounded(
        `${this.prefix}/acknowledgements/${first.seal.lastSequence}`,
        LIMIT
      ),
      this.options.store.readBounded(
        `${this.prefix}/seal-acknowledgements/${first.seal.sealHash}`,
        LIMIT
      ),
      this.options.store.readBounded(
        `${this.prefix}/seal-segments/${first.seal.sealHash}/original`,
        first.seal.originalBytes
      ),
      this.options.store.readBounded(
        `${this.prefix}/seal-segments/${first.seal.sealHash}/wrapper`,
        first.seal.wrapperBytes
      ),
      this.options.mirror.readSealBounded(first.seal.revision, LIMIT),
      first.seal.schema === "lyrashield-journal-seal/2"
        ? this.options.store.readBounded(
            `${this.prefix}/recovery-snapshots/${first.seal.sealHash}`,
            first.seal.recoverySnapshotBytes
          )
        : Promise.resolve(null),
    ])
    if (
      !sealObject ||
      !journalAckObject ||
      !sealAckObject ||
      !originalArchive ||
      !wrapperArchive ||
      !mirroredSeal ||
      !sealObject.etag ||
      !journalAckObject.etag ||
      !sealAckObject.etag ||
      !originalArchive.etag ||
      !wrapperArchive.etag
    )
      throw new Error("journal seal or observed acknowledgement is unavailable")
    const seal = verifyJournalSeal(parseCanonical(sealObject.bytes), this.options.sealSigningSecret)
    const journalAck = journalAckSchema.parse(parseCanonical(journalAckObject.bytes))
    const ackHead = verifyHead(journalAck.head, this.options.headSigningSecret, stream)
    const { signature: journalSignature, ...journalBody } = journalAck
    const sealAck = verifyObservedSealAck(
      parseCanonical(sealAckObject.bytes),
      this.options.sealSigningSecret
    )
    if (
      seal.schema === "lyrashield-journal-seal/2" &&
      (!recoverySnapshot ||
        !recoverySnapshot.etag ||
        recoverySnapshot.bytes.byteLength !== seal.recoverySnapshotBytes ||
        digest(recoverySnapshot.bytes) !== seal.recoverySnapshotSha256)
    )
      throw new Error("sealed recovery snapshot is unavailable or changed")
    if (
      canonicalJson(seal) !== canonicalJson(first.seal) ||
      canonicalJson(verifyJournalSeal(mirroredSeal, this.options.sealSigningSecret)) !==
        canonicalJson(seal) ||
      !equal(journalSignature, signature(this.options.headSigningSecret, journalBody)) ||
      ackHead.sequence !== seal.lastSequence ||
      ackHead.recordHash !== seal.wrapperLastHash ||
      digest(journalAckObject.bytes) !== seal.observedJournalAckHash ||
      originalArchive.bytes.byteLength !== seal.originalBytes ||
      wrapperArchive.bytes.byteLength !== seal.wrapperBytes ||
      digest(originalArchive.bytes) !== seal.originalSegmentSha256 ||
      digest(wrapperArchive.bytes) !== seal.wrapperSegmentSha256 ||
      sealAck.epochId !== stream.epochId ||
      sealAck.supervisorInstanceId !== stream.supervisorInstanceId ||
      sealAck.revision !== seal.revision ||
      sealAck.sealHash !== seal.sealHash
    )
      throw new Error("journal seal observed acknowledgement differs")
    return {
      sealBytes: Buffer.from(sealObject.bytes),
      journalAck: Buffer.from(journalAckObject.bytes),
      sealAck: Buffer.from(sealAckObject.bytes),
      originalArchive: Buffer.from(originalArchive.bytes),
      wrapperArchive: Buffer.from(wrapperArchive.bytes),
      recoverySnapshot: recoverySnapshot ? Buffer.from(recoverySnapshot.bytes) : null,
      etags: [
        sealObject.etag,
        journalAckObject.etag,
        sealAckObject.etag,
        originalArchive.etag,
        wrapperArchive.etag,
        recoverySnapshot?.etag ?? null,
      ],
    }
  }

  private async readEvidence(
    input: { epochId: string; supervisorInstanceId: string },
    allowNewerHead: boolean
  ): Promise<JournalSealEvidence | null> {
    const stream = streamSchema.parse(input)
    if (canonicalJson(stream) !== canonicalJson(this.stream))
      throw new Error("foreign journal seal stream")

    const first = await this.readHeads(stream, allowNewerHead)
    if (!first) return null

    const evidence = await this.readObjects(first, stream)
    await auditJournalSealArchives(first.seal, this.options.store, {
      originalSigningSecret: this.options.originalSigningSecret,
      wrapperSigningSecret: this.options.wrapperSigningSecret,
      sealSigningSecret: this.options.sealSigningSecret,
      validateOriginal: this.options.validateOriginal,
    })
    const second = await this.readHeads(stream, allowNewerHead)
    const rechecked = await this.readObjects(first, stream)
    if (
      !second ||
      canonicalJson(second) !== canonicalJson(first) ||
      !evidence.sealBytes.equals(rechecked.sealBytes) ||
      !evidence.journalAck.equals(rechecked.journalAck) ||
      !evidence.sealAck.equals(rechecked.sealAck) ||
      !evidence.originalArchive.equals(rechecked.originalArchive) ||
      !evidence.wrapperArchive.equals(rechecked.wrapperArchive) ||
      (evidence.recoverySnapshot === null
        ? rechecked.recoverySnapshot !== null
        : !rechecked.recoverySnapshot ||
          !evidence.recoverySnapshot.equals(rechecked.recoverySnapshot)) ||
      canonicalJson(evidence.etags) !== canonicalJson(rechecked.etags)
    )
      throw new Error("journal seal evidence changed during readback")
    return {
      seal: first.seal,
      journalHead: first.head,
      journalObservedAck: evidence.journalAck,
      sealObservedAck: evidence.sealAck,
    }
  }
}
