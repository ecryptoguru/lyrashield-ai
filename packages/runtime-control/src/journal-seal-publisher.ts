import { createHash, createHmac } from "node:crypto"
import { canonicalJson } from "./canonical-json"
import {
  type AuthorityEvent,
  type AuthorityHead,
  IndependentAuthorityJournal,
  type BoundedConditionalObjectStore,
} from "./independent-journal"
import type { JournalPort, JournalRecord } from "./journal"
import {
  createJournalSeal,
  createObservedSealAck,
  verifyJournalSeal,
  type JournalSeal,
} from "./journal-seal"
import { auditJournalSealArchives } from "./journal-seal-archive"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"

const LIMIT = 1024 * 1024
const METADATA_LIMIT = 16 * 1024
const ZERO = "0".repeat(64)
interface SealMirror {
  readHeadBounded(maxBytes: number): Promise<AuthorityHead | null>
  readSealHeadBounded(maxBytes: number): Promise<JournalSeal | null>
  readSealBounded(revision: number, maxBytes: number): Promise<JournalSeal | null>
  compareAndAppendSeal(
    previous: JournalSeal | null,
    next: JournalSeal,
    expectedHead: AuthorityHead
  ): Promise<"written" | "conflict">
}
/** Must serialize publication with all appends and provide a real cancellation fence. */
export interface JournalSealPublicationFence {
  run<T>(operation: (assertActive: () => void) => Promise<T>): Promise<T>
}
export interface JournalRecoverySnapshotProvider {
  create(input: {
    epochId: string
    supervisorInstanceId: string
    lastSequence: number
    originalLastHash: string
    wrapperLastHash: string
  }): Promise<{
    bytes: Uint8Array
    sequence: number
    originalLastHash: string
    wrapperLastHash: string
  }>
}
interface PublisherOptions<T> {
  epochId: string
  supervisorInstanceId: string
  original: JournalPort<T>
  wrapper: JournalPort<AuthorityEvent<JournalRecord<T>>>
  independent: IndependentAuthorityJournal<JournalRecord<T>>
  store: BoundedConditionalObjectStore
  mirror: SealMirror
  pin: ProtectedJournalSealPinStore
  fence: JournalSealPublicationFence
  originalSigningSecret: string
  wrapperSigningSecret: string
  headSigningSecret: string
  sealSigningSecret: string
  validateOriginal: (value: unknown) => T
  recoverySnapshot?: JournalRecoverySnapshotProvider
}
function bytesHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
function sign(secret: string, value: unknown): string {
  if (Buffer.byteLength(secret) < 32) throw new Error("journal seal key is too short")
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex")
}
function observedJournalAck<T>(
  record: JournalRecord<AuthorityEvent<JournalRecord<T>>>,
  supervisorInstanceId: string,
  secret: string
): Uint8Array {
  const { epochId, operationId, scanId, workspaceId, attemptId, eventId } = record.payload
  const headBody = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId,
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
  const head = { ...headBody, signature: sign(secret, headBody) }
  const body = { schema: "lyrashield-supervisor-observed-mirror-ack/1" as const, head }
  return Buffer.from(canonicalJson({ ...body, signature: sign(secret, body) }))
}

type Checked = <R>(operation: () => Promise<R>) => Promise<R>
interface PreparedSeal {
  seal: JournalSeal
  head: AuthorityHead
  originalBytes: Buffer
  wrapperBytes: Buffer
  recoverySnapshot?: Buffer
}

export class JournalSealPendingError extends Error {
  constructor(
    readonly sealHash: string,
    cause: unknown
  ) {
    super(
      `journal seal publication unresolved: ${cause instanceof Error ? cause.message : "unknown outcome"}`
    )
    this.name = "JournalSealPendingError"
  }
}

/** Publishes a bounded sealed prefix; no caller can supply the protected current pin. */
export class JournalSealPublisher<T> {
  private readonly stream: { epochId: string; supervisorInstanceId: string }
  private readonly prefix: string
  private readonly options: Readonly<PublisherOptions<T>>
  constructor(options: PublisherOptions<T>) {
    this.options = Object.freeze({ ...options })
    this.stream = { epochId: options.epochId, supervisorInstanceId: options.supervisorInstanceId }
    if (
      !same(options.independent.streamIdentity(), this.stream) ||
      !(options.pin instanceof ProtectedJournalSealPinStore) ||
      !options.original.readRawRange ||
      !options.wrapper.readRawRange ||
      !options.fence?.run
    )
      throw new Error("protected journal sealing dependencies are unavailable")
    this.prefix = `epochs/${this.stream.epochId}/supervisors/${this.stream.supervisorInstanceId}`
  }

  async publishNext(input: { resumeSealHash?: string } = {}): Promise<JournalSeal> {
    if (input.resumeSealHash !== undefined && !/^[a-f0-9]{64}$/.test(input.resumeSealHash))
      throw new Error("invalid journal seal selector")
    return this.options.fence.run(async (assertActive) => {
      const checked: Checked = async (operation) => {
        assertActive()
        const value = await operation()
        assertActive()
        return value
      }
      let pin
      try {
        pin = await checked(() => this.options.pin.readCurrent(this.stream))
      } catch (error) {
        if (!input.resumeSealHash) throw error
        pin = await checked(() => this.options.pin.retryPending(this.stream, input.resumeSealHash!))
      }
      if (pin && input.resumeSealHash === pin.sealHash)
        return this.reobservePinned(pin.sealHash, pin, checked)
      const previous = pin
        ? await checked(() => this.options.mirror.readSealBounded(pin.revision, METADATA_LIMIT))
        : null
      if (
        pin &&
        (!previous ||
          verifyJournalSeal(previous, this.options.sealSigningSecret).sealHash !== pin.sealHash ||
          previous.lastSequence !== pin.lastSequence)
      )
        throw new Error("protected prior seal is unavailable")
      const prepared = await this.prepare(previous, checked)
      if (input.resumeSealHash && input.resumeSealHash !== prepared.seal.sealHash)
        throw new Error("journal seal selector differs from the original prepared seal")
      try {
        await this.publishPrepared(previous, prepared, checked)
        const advance = await checked(() =>
          this.options.pin.compareAndAdvance({ stream: this.stream, expected: pin })
        )
        if (advance !== "advanced") throw new Error("protected journal seal pin changed")
        const pinned = await checked(() => this.options.pin.readCurrent(this.stream))
        if (
          !pinned ||
          pinned.sealHash !== prepared.seal.sealHash ||
          pinned.revision !== prepared.seal.revision
        )
          throw new Error("protected journal seal pin is unresolved")
        return prepared.seal
      } catch (error) {
        throw new JournalSealPendingError(prepared.seal.sealHash, error)
      }
    })
  }

  private async reobservePinned(
    selector: string,
    pin: NonNullable<Awaited<ReturnType<ProtectedJournalSealPinStore["readCurrent"]>>>,
    checked: Checked
  ): Promise<JournalSeal> {
    const reader = new StoredJournalSealEvidenceReader({
      ...this.stream,
      store: this.options.store,
      mirror: this.options.mirror,
      headSigningSecret: this.options.headSigningSecret,
      sealSigningSecret: this.options.sealSigningSecret,
      originalSigningSecret: this.options.originalSigningSecret,
      wrapperSigningSecret: this.options.wrapperSigningSecret,
      validateOriginal: this.options.validateOriginal,
    })
    const evidence = await checked(() => reader.readCurrentSealEvidence(this.stream))
    if (
      !evidence ||
      evidence.seal.sealHash !== selector ||
      evidence.seal.revision !== pin.revision ||
      evidence.seal.lastSequence !== pin.lastSequence ||
      evidence.seal.originalLastHash !== pin.originalLastHash ||
      evidence.seal.wrapperLastHash !== pin.wrapperLastHash ||
      evidence.seal.independentHeadHash !== pin.independentHeadHash ||
      bytesHash(evidence.journalObservedAck) !== pin.observedJournalAckHash ||
      bytesHash(evidence.sealObservedAck) !== pin.observedSealAckHash
    )
      throw new Error("protected journal seal evidence differs")
    await checked(() =>
      auditJournalSealArchives(evidence.seal, this.options.store, {
        originalSigningSecret: this.options.originalSigningSecret,
        wrapperSigningSecret: this.options.wrapperSigningSecret,
        sealSigningSecret: this.options.sealSigningSecret,
        validateOriginal: this.options.validateOriginal,
      })
    )
    const repeated = await checked(() => reader.readCurrentSealEvidence(this.stream))
    const currentPin = await checked(() => this.options.pin.readCurrent(this.stream))
    if (
      !repeated ||
      !same(currentPin, pin) ||
      !same(repeated.seal, evidence.seal) ||
      !same(repeated.journalHead, evidence.journalHead) ||
      !Buffer.from(repeated.journalObservedAck).equals(Buffer.from(evidence.journalObservedAck)) ||
      !Buffer.from(repeated.sealObservedAck).equals(Buffer.from(evidence.sealObservedAck))
    )
      throw new Error("protected journal seal changed during replay")
    return evidence.seal
  }

  private async prepare(previous: JournalSeal | null, checked: Checked): Promise<PreparedSeal> {
    const after = previous?.lastSequence ?? 0
    const readOriginal = (count: number) =>
      this.options.original.readRawRange!(after, { maxBytes: LIMIT, maxRecords: count })
    const readWrapper = (count: number) =>
      this.options.wrapper.readRawRange!(after, { maxBytes: LIMIT, maxRecords: count })
    let original = await checked(() => readOriginal(32))
    let wrapper = await checked(() => readWrapper(32))
    const count = Math.min(original.records.length, wrapper.records.length)
    if (!count) throw new Error("no confirmed journal records are available to seal")
    if (original.records.length !== count) original = await checked(() => readOriginal(count))
    if (wrapper.records.length !== count) wrapper = await checked(() => readWrapper(count))
    const confirmed = await checked(() =>
      this.options.independent.loadConfirmedRange(after, {
        maxBytes: 2 * LIMIT,
        maxRecords: count,
      })
    )
    const head = this.options.independent.confirmedHead()
    if (
      !head ||
      confirmed.records.length !== count ||
      !same(confirmed.records, wrapper.range.records) ||
      !same(confirmed.head, wrapper.range.head) ||
      !same(original.range.head, confirmed.head?.payload.payload) ||
      !same(
        original.range.records,
        confirmed.records.map((record) => record.payload.payload)
      ) ||
      original.range.previousHash !== (previous?.originalLastHash ?? ZERO) ||
      wrapper.range.previousHash !== (previous?.wrapperLastHash ?? ZERO)
    )
      throw new Error("original and confirmed journal ranges disagree")
    const first = original.range.records[0]!,
      last = original.range.records.at(-1)!,
      wrappedLast = confirmed.records.at(-1)!
    if (
      first.sequence !== after + 1 ||
      last.sequence !== after + count ||
      wrappedLast.sequence !== last.sequence
    )
      throw new Error("journal seal range is not contiguous")
    const originalBytes = Buffer.concat(original.records.map((value) => Buffer.from(value)))
    const wrapperBytes = Buffer.concat(wrapper.records.map((value) => Buffer.from(value)))
    const expectedAck = observedJournalAck(
      wrappedLast,
      this.stream.supervisorInstanceId,
      this.options.headSigningSecret
    )
    const ack = await checked(() =>
      this.options.store.readBounded(
        `${this.prefix}/acknowledgements/${last.sequence}`,
        METADATA_LIMIT
      )
    )
    if (!ack || !Buffer.from(ack.bytes).equals(Buffer.from(expectedAck)))
      throw new Error("observed journal acknowledgement is unavailable")
    const candidate = this.options.recoverySnapshot
      ? await checked(() =>
          this.options.recoverySnapshot!.create({
            ...this.stream,
            lastSequence: last.sequence,
            originalLastHash: last.hash,
            wrapperLastHash: wrappedLast.hash,
          })
        )
      : undefined
    if (this.options.recoverySnapshot && !candidate)
      throw new Error("sealed recovery snapshot provider returned no candidate")
    let recoverySnapshot: Buffer | undefined
    if (candidate) {
      recoverySnapshot = Buffer.from(candidate.bytes)
      if (
        !original.endPosition ||
        !wrapper.endPosition ||
        recoverySnapshot.byteLength < 1 ||
        recoverySnapshot.byteLength > LIMIT ||
        candidate.sequence !== last.sequence ||
        candidate.originalLastHash !== last.hash ||
        candidate.wrapperLastHash !== wrappedLast.hash
      )
        throw new Error("sealed recovery snapshot or tail positions differ")
      const snapshotText = recoverySnapshot.toString("utf8")
      const snapshot: unknown = JSON.parse(snapshotText)
      if (
        !Buffer.from(snapshotText).equals(recoverySnapshot) ||
        canonicalJson(snapshot) !== snapshotText ||
        !snapshot ||
        typeof snapshot !== "object" ||
        Reflect.get(snapshot, "schema") !== "lyrashield-supervisor-recovery-snapshot/1" ||
        Reflect.get(snapshot, "epochId") !== this.stream.epochId ||
        Reflect.get(snapshot, "supervisorInstanceId") !== this.stream.supervisorInstanceId ||
        Reflect.get(snapshot, "sequence") !== last.sequence ||
        Reflect.get(snapshot, "originalHash") !== last.hash ||
        Reflect.get(snapshot, "wrapperHash") !== wrappedLast.hash
      )
        throw new Error("sealed recovery snapshot anchor differs")
    }
    const common = {
      ...this.stream,
      revision: (previous?.revision ?? 0) + 1,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      previousSealHash: previous?.sealHash ?? ZERO,
      originalPreviousHash: original.range.previousHash,
      originalLastHash: last.hash,
      wrapperPreviousHash: wrapper.range.previousHash,
      wrapperLastHash: wrappedLast.hash,
      originalSegmentSha256: bytesHash(originalBytes),
      wrapperSegmentSha256: bytesHash(wrapperBytes),
      originalBytes: originalBytes.byteLength,
      wrapperBytes: wrapperBytes.byteLength,
      recordCount: count,
      independentHeadHash: bytesHash(Buffer.from(canonicalJson(head))),
      observedJournalAckHash: bytesHash(ack.bytes),
    }
    const seal = createJournalSeal(
      recoverySnapshot
        ? {
            ...common,
            schema: "lyrashield-journal-seal/2",
            originalSegmentStartSequence: original.endPosition!.segmentStartSequence,
            originalByteOffset: original.endPosition!.byteOffsetAfterLastSealedRecord,
            wrapperSegmentStartSequence: wrapper.endPosition!.segmentStartSequence,
            wrapperByteOffset: wrapper.endPosition!.byteOffsetAfterLastSealedRecord,
            recoverySnapshotSha256: bytesHash(recoverySnapshot),
            recoverySnapshotBytes: recoverySnapshot.byteLength,
          }
        : { ...common, schema: "lyrashield-journal-seal/1" },
      this.options.sealSigningSecret
    )
    return {
      seal,
      head,
      originalBytes,
      wrapperBytes,
      ...(recoverySnapshot ? { recoverySnapshot } : {}),
    }
  }

  private async immutable(checked: Checked, key: string, bytes: Uint8Array): Promise<void> {
    const result = await checked(() => this.options.store.put(key, bytes, { ifNoneMatch: true }))
    if (result !== "written" && result !== "conflict")
      throw new Error("immutable seal write is unresolved")
    const stored = await checked(() => this.options.store.readBounded(key, bytes.byteLength))
    if (!stored || !Buffer.from(stored.bytes).equals(Buffer.from(bytes)))
      throw new Error("immutable seal object differs")
  }

  private async publishPrepared(
    previous: JournalSeal | null,
    prepared: PreparedSeal,
    checked: Checked
  ): Promise<void> {
    const { seal, head, originalBytes, wrapperBytes, recoverySnapshot } = prepared
    const sealBytes = Buffer.from(canonicalJson(seal))
    const prefix = `${this.prefix}/seal-segments/${seal.sealHash}`
    await this.immutable(checked, `${prefix}/original`, originalBytes)
    await this.immutable(checked, `${prefix}/wrapper`, wrapperBytes)
    await this.immutable(checked, `${this.prefix}/seals/${seal.sealHash}`, sealBytes)
    if (seal.schema === "lyrashield-journal-seal/2") {
      if (!recoverySnapshot) throw new Error("sealed recovery snapshot is unavailable")
      await this.immutable(
        checked,
        `${this.prefix}/recovery-snapshots/${seal.sealHash}`,
        recoverySnapshot
      )
      await this.immutable(
        checked,
        `${this.prefix}/seal-journal-heads/${seal.independentHeadHash}`,
        Buffer.from(canonicalJson(head))
      )
    }
    await checked(() =>
      auditJournalSealArchives(seal, this.options.store, {
        originalSigningSecret: this.options.originalSigningSecret,
        wrapperSigningSecret: this.options.wrapperSigningSecret,
        sealSigningSecret: this.options.sealSigningSecret,
        validateOriginal: this.options.validateOriginal,
      })
    )
    const result = await checked(() =>
      this.options.mirror.compareAndAppendSeal(previous, seal, head)
    )
    if (result !== "written") throw new Error("journal seal mirror compare-and-append conflicted")
    // Only a positively observed successful mirror call permits signing this ACK.
    const sealAck = Buffer.from(
      canonicalJson(createObservedSealAck(seal, this.options.sealSigningSecret))
    )
    await this.immutable(checked, `${this.prefix}/seal-acknowledgements/${seal.sealHash}`, sealAck)
    const existing = await checked(() =>
      this.options.store.readBounded(`${this.prefix}/seal-head`, METADATA_LIMIT)
    )
    if (
      existing &&
      !same(
        verifyJournalSeal(
          JSON.parse(Buffer.from(existing.bytes).toString("utf8")),
          this.options.sealSigningSecret
        ),
        seal
      )
    ) {
      if (
        !previous ||
        !same(
          verifyJournalSeal(
            JSON.parse(Buffer.from(existing.bytes).toString("utf8")),
            this.options.sealSigningSecret
          ),
          previous
        )
      )
        throw new Error("journal seal object head conflicts")
    } else if (!existing && previous)
      throw new Error("journal seal object predecessor is unavailable")
    if (!existing || !Buffer.from(existing.bytes).equals(sealBytes)) {
      const update = await checked(() =>
        this.options.store.put(
          `${this.prefix}/seal-head`,
          sealBytes,
          existing ? { ifMatch: existing.etag } : { ifNoneMatch: true }
        )
      )
      if (update !== "written") throw new Error("journal seal object head changed")
    }
  }
}
