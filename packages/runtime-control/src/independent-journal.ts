import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import type { JournalPort, JournalRecord, JournalRange, JournalReadLimits } from "./journal"

// This is an offline protocol foundation, not a production admission gate.
// The caller must supply independently protected storage, a durable database
// mirror, qualified epoch authorization, and persisted scan-bound authority.
const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const commonFields = {
  epochId: id,
  operationId: id,
  scanId: id,
  workspaceId: id,
  attemptId: id,
  eventId: id,
}

export function authorityEventSchema<T extends z.ZodType>(payload: T) {
  return z.object({ ...commonFields, payload }).strict()
}

export type AuthorityEvent<T> = z.infer<ReturnType<typeof authorityEventSchema<z.ZodType<T>>>>

export const headSchema = z
  .object({
    schema: z.literal("lyrashield-independent-authority-head/1"),
    supervisorInstanceId: id,
    ...commonFields,
    sequence: z.number().int().positive().safe(),
    previousHash: hash,
    recordHash: hash,
    signature: hash,
  })
  .strict()
export type AuthorityHead = z.infer<typeof headSchema>

export interface StoredObject {
  bytes: Uint8Array
  etag: string
}

export interface ConditionalObjectStore {
  read(key: string): Promise<StoredObject | null>
  put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ): Promise<"written" | "conflict">
}

export interface BoundedConditionalObjectStore extends ConditionalObjectStore {
  /** Enforce this limit during transport, before accumulating an oversized response. */
  readBounded(key: string, maxBytes: number): Promise<StoredObject | null>
}

export interface AuthorityMirror {
  readHead(): Promise<AuthorityHead | null>
  readRecord(sequence: number): Promise<JournalRecord<unknown> | null>
  /**
   * Atomically insert the immutable record and advance only from the exact
   * expected predecessor; an identical existing record is a safe replay.
   * A stale or foreign predecessor must never overwrite a newer mirror head.
   */
  compareAndAppend(
    expectedPrevious: AuthorityHead | null,
    head: AuthorityHead,
    record: JournalRecord<unknown>
  ): Promise<"written" | "conflict">
}

export interface BoundedAuthorityMirror extends AuthorityMirror {
  /** Enforce caller-sized limits in SQL before text reaches the driver. */
  readHeadBounded(maxBytes: number): Promise<AuthorityHead | null>
  readRecordBounded(sequence: number, maxBytes: number): Promise<JournalRecord<unknown> | null>
}

export class IndependentAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "IndependentAuthorityError"
  }
}

export interface IndependentAuthorityJournalOptions<T> {
  local: JournalPort<AuthorityEvent<T>>
  store: ConditionalObjectStore
  mirror: AuthorityMirror
  epochId: string
  supervisorInstanceId: string
  signingSecret: string
  payloadSchema: z.ZodType<T>
  // The implementation must atomically validate the epoch and all persisted
  // event bindings. Returning from this journal is not execution permission;
  // the supervisor must independently fence the epoch at each physical action.
  authorize: (event: AuthorityEvent<T>) => Promise<boolean>
  // Called only after all durable records, heads and observed ACKs agree.
  // Historical identity checks must not grant permission for a new append.
  authorizeConfirmed?: (record: JournalRecord<AuthorityEvent<T>>) => Promise<boolean>
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function unknown(message: string): IndependentAuthorityError {
  return new IndependentAuthorityError("AUTHORITY_UNKNOWN", message)
}

function conflict(message: string): IndependentAuthorityError {
  return new IndependentAuthorityError("AUTHORITY_CONFLICT", message)
}

export class IndependentAuthorityJournal<T> {
  private readonly options: IndependentAuthorityJournalOptions<T>
  private readonly eventSchema: ReturnType<typeof authorityEventSchema<z.ZodType<T>>>
  private readonly prefix: string
  private readonly byEvent = new Map<string, JournalRecord<AuthorityEvent<T>>>()
  private records: JournalRecord<AuthorityEvent<T>>[] | null = null
  private confirmed = 0
  private pending: JournalRecord<AuthorityEvent<T>> | null = null
  private pendingRequiresConfirmation = false
  private serial: Promise<void> = Promise.resolve()
  private failed: IndependentAuthorityError | null = null

  constructor(options: IndependentAuthorityJournalOptions<T>) {
    id.parse(options.epochId)
    id.parse(options.supervisorInstanceId)
    if (Buffer.byteLength(options.signingSecret, "utf8") < 32) {
      throw new Error("independent authority signing secret must be at least 32 bytes")
    }
    this.eventSchema = authorityEventSchema(options.payloadSchema)
    this.prefix = `epochs/${options.epochId}/supervisors/${options.supervisorInstanceId}`
    this.options = Object.freeze({ ...options })
  }

  streamIdentity(): Readonly<{ epochId: string; supervisorInstanceId: string }> {
    return Object.freeze({
      epochId: this.options.epochId,
      supervisorInstanceId: this.options.supervisorInstanceId,
    })
  }

  async appendIntent(input: AuthorityEvent<T>): Promise<JournalRecord<AuthorityEvent<T>>> {
    const run = this.serial.then(() => this.appendSerial(input))
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Read authenticated, fully mirrored history without repairing or advancing it.
   * An unresolved append must be replayed through its original event identity.
   * This is recovery evidence, never permission to perform a physical action.
   */
  async loadConfirmed(): Promise<JournalRecord<AuthorityEvent<T>>[]> {
    const run = this.serial.then(() => this.loadConfirmedSerial())
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Bounded warm read, anchored to the fully verified startup chain and all three current heads. */
  async loadConfirmedRange(
    afterSequence: number,
    limits: JournalReadLimits
  ): Promise<JournalRange<AuthorityEvent<T>>> {
    const run = this.serial.then(async () => {
      if (this.failed) throw this.failed
      try {
        const local = this.options.local
        const store = this.options.store as BoundedConditionalObjectStore
        const mirror = this.options.mirror as BoundedAuthorityMirror
        if (
          !local.readRange ||
          !store.readBounded ||
          !mirror.readHeadBounded ||
          !mirror.readRecordBounded
        ) {
          throw unknown("bounded independent journal ports are unavailable")
        }
        await this.initialize()
        if (this.pending)
          throw new IndependentAuthorityError(
            "REPLAY_REQUIRED",
            "replay the unresolved event identity"
          )
        const deadline = performance.now() + 5000
        const assertDeadline = () => {
          if (performance.now() >= deadline) throw unknown("bounded journal read deadline exceeded")
        }
        const range = await local.readRange(afterSequence, limits)
        assertDeadline()
        const expected = this.confirmed ? this.records![this.confirmed - 1]! : null
        if (!same(range.head, expected))
          throw conflict("local range head differs from confirmed history")
        if (
          range.previousHash !== (this.records![afterSequence - 1]?.hash ?? "0".repeat(64)) ||
          !same(
            range.records,
            this.records!.slice(afterSequence, afterSequence + range.records.length)
          ) ||
          range.hasMore !== afterSequence + range.records.length < this.confirmed
        ) {
          throw conflict("local range differs from confirmed history")
        }
        const verifyHeads = async () => {
          assertDeadline()
          const object = await store.readBounded(`${this.prefix}/head`, 64 * 1024)
          assertDeadline()
          const head = object
            ? this.parseHead(JSON.parse(Buffer.from(object.bytes).toString("utf8")))
            : null
          const value = await mirror.readHeadBounded(64 * 1024)
          assertDeadline()
          const mirrored = value ? this.parseHead(value) : null
          const signed = expected ? this.headFor(expected) : null
          if (!same(head, signed) || !same(mirrored, signed))
            throw conflict("bounded authority heads disagree")
          assertDeadline()
        }
        const verifyRecords = async () => {
          const selected = [...range.records]
          if (expected && !selected.some((record) => record.sequence === expected.sequence))
            selected.push(expected)
          for (const record of selected) {
            assertDeadline()
            const bytes = this.recordBytes(record)
            const object = await store.readBounded(
              `${this.prefix}/records/${record.sequence}`,
              bytes.byteLength
            )
            assertDeadline()
            const mirrored = await mirror.readRecordBounded(
              record.sequence,
              Buffer.byteLength(canonicalJson(record))
            )
            assertDeadline()
            if (!object || !mirrored) throw unknown("bounded authority record is unavailable")
            if (!Buffer.from(object.bytes).equals(bytes) || !same(mirrored, record))
              throw conflict("bounded authority record differs")
            if (!(await this.hasAcknowledgement(record, true)))
              throw unknown("observed mirror acknowledgement is unavailable")
            await this.assertConfirmedAuthorized(record)
            assertDeadline()
          }
        }
        await verifyHeads()
        await verifyRecords()
        if (!same(range, await local.readRange(afterSequence, limits)))
          throw conflict("local range changed during readback")
        await verifyRecords()
        await verifyHeads()
        return range
      } catch (error) {
        if (error instanceof IndependentAuthorityError) {
          if (error.code === "AUTHORITY_CONFLICT") this.failed = error
          throw error
        }
        throw unknown("bounded independent history is unresolved")
      }
    })
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Last verified observation only; callers must first complete a confirmed read. */
  confirmedHead(): AuthorityHead | null {
    if (!this.records || this.pending || this.failed)
      throw unknown("confirmed authority head is unavailable")
    return this.confirmed ? this.headFor(this.records[this.confirmed - 1]!) : null
  }

  private async loadConfirmedSerial(): Promise<JournalRecord<AuthorityEvent<T>>[]> {
    if (this.failed) throw this.failed
    try {
      await this.initialize()
      if (this.pending) {
        throw new IndependentAuthorityError(
          "REPLAY_REQUIRED",
          "replay the unresolved event identity"
        )
      }
      await this.assertConfirmed()
      for (const record of this.records!) await this.assertConfirmedAuthorized(record)
      // Recheck after authorization reads so a concurrent durable-head change
      // cannot be returned as a successfully reconciled recovery snapshot.
      await this.assertConfirmed()
      return structuredClone(this.records!)
    } catch (error) {
      if (error instanceof IndependentAuthorityError) {
        if (error.code === "AUTHORITY_CONFLICT") this.failed = error
        throw error
      }
      throw unknown("independent authority history is unresolved")
    }
  }

  private async appendSerial(input: AuthorityEvent<T>): Promise<JournalRecord<AuthorityEvent<T>>> {
    if (this.failed) throw this.failed
    const event = this.eventSchema.parse(input)
    if (event.epochId !== this.options.epochId) throw conflict("event belongs to a different epoch")
    try {
      if (!(await this.options.authorize(event))) {
        throw conflict("epoch or persisted event authority is unavailable")
      }
      await this.initialize()
      const existing = this.byEvent.get(event.eventId)
      if (existing && !same(existing.payload, event)) {
        throw new IndependentAuthorityError("IDENTITY_CONFLICT", "event identity was reused")
      }
      if (this.pending && this.pending.payload.eventId !== event.eventId) {
        throw new IndependentAuthorityError(
          "REPLAY_REQUIRED",
          "replay the unresolved event identity"
        )
      }
      if (existing && !this.pending) {
        await this.assertConfirmed()
        await this.assertAuthorized(event)
        return structuredClone(existing)
      }
      if (!this.pending) {
        await this.assertConfirmed()
        const record = await this.options.local.append(event)
        this.records!.push(record)
        this.byEvent.set(event.eventId, record)
        this.pending = record
      }
      const record = this.pending
      if (this.pendingRequiresConfirmation) {
        if (!this.options.local.confirmRecord) {
          throw unknown("pending local record requires explicit fsync confirmation")
        }
        const local = await this.options.local.confirmRecord(record)
        if (!same(local, record))
          throw conflict("local replay confirmation changed the signed record")
        this.pendingRequiresConfirmation = false
      }
      await this.persist(record)
      await this.assertHeads(record.sequence)
      await this.assertAuthorized(event)
      // This signature is created only after the mirror response was received.
      const acknowledgement = this.acknowledgementBytes(record)
      await this.options.store.put(
        `${this.prefix}/acknowledgements/${record.sequence}`,
        acknowledgement,
        { ifNoneMatch: true }
      )
      if (!(await this.hasAcknowledgement(record)))
        throw unknown("observed mirror acknowledgement is unavailable")
      this.confirmed = record.sequence
      this.pending = null
      return structuredClone(record)
    } catch (error) {
      if (error instanceof IndependentAuthorityError) {
        if (error.code === "AUTHORITY_CONFLICT") this.failed = error
        throw error
      }
      throw unknown("independent authority outcome is unresolved")
    }
  }

  private async assertAuthorized(event: AuthorityEvent<T>): Promise<void> {
    if (!(await this.options.authorize(event))) {
      throw conflict("epoch or persisted event authority changed before dispatch")
    }
  }

  private async assertConfirmedAuthorized(record: JournalRecord<AuthorityEvent<T>>): Promise<void> {
    if (!this.options.authorizeConfirmed) return this.assertAuthorized(record.payload)
    if (!(await this.options.authorizeConfirmed(record))) {
      throw conflict("confirmed event identity is unavailable")
    }
  }

  private sign(value: unknown): string {
    return createHmac("sha256", this.options.signingSecret)
      .update(canonicalJson(value))
      .digest("hex")
  }

  private headFor(record: JournalRecord<AuthorityEvent<T>>): AuthorityHead {
    const { epochId, operationId, scanId, workspaceId, attemptId, eventId } = record.payload
    const unsigned = {
      schema: "lyrashield-independent-authority-head/1" as const,
      supervisorInstanceId: this.options.supervisorInstanceId,
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
    return { ...unsigned, signature: this.sign(unsigned) }
  }

  private parseHead(value: unknown): AuthorityHead {
    const parsed = headSchema.safeParse(value)
    if (!parsed.success) throw conflict("independent authority head is malformed")
    const { signature, ...unsigned } = parsed.data
    if (
      !safeEqual(signature, this.sign(unsigned)) ||
      parsed.data.epochId !== this.options.epochId ||
      parsed.data.supervisorInstanceId !== this.options.supervisorInstanceId
    ) {
      throw conflict("independent authority head identity or signature is invalid")
    }
    return parsed.data
  }

  private recordBytes(record: JournalRecord<AuthorityEvent<T>>): Buffer {
    const unsigned = {
      schema: "lyrashield-independent-authority-record/1",
      supervisorInstanceId: this.options.supervisorInstanceId,
      record,
    }
    return Buffer.from(canonicalJson({ ...unsigned, signature: this.sign(unsigned) }), "utf8")
  }

  private async readRemoteHead(): Promise<{ head: AuthorityHead; etag: string } | null> {
    const object = await this.options.store.read(`${this.prefix}/head`)
    if (!object) return null
    if (!object.etag || object.bytes.byteLength > 64 * 1024)
      throw conflict("authority head is invalid")
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(object.bytes).toString("utf8"))
    } catch {
      throw conflict("authority head is not valid JSON")
    }
    return { head: this.parseHead(value), etag: object.etag }
  }

  private async readMirrorHead(): Promise<AuthorityHead | null> {
    const value = await this.options.mirror.readHead()
    return value ? this.parseHead(value) : null
  }

  private assertLocalHead(head: AuthorityHead | null): number {
    if (!head) return 0
    const record = this.records?.[head.sequence - 1]
    if (!record || !same(this.headFor(record), head)) {
      throw conflict("local and independent authority histories disagree")
    }
    return head.sequence
  }

  private async initialize(): Promise<void> {
    if (this.records) return
    const records = await this.options.local.load()
    this.records = records
    try {
      for (const record of records) {
        const event = this.eventSchema.parse(record.payload)
        if (event.epochId !== this.options.epochId || this.byEvent.has(event.eventId)) {
          throw conflict("local authority history has a foreign or duplicate event")
        }
        this.byEvent.set(event.eventId, record)
      }
      const remote = await this.readRemoteHead()
      const mirrored = await this.readMirrorHead()
      const remoteSeq = this.assertLocalHead(remote?.head ?? null)
      const mirrorSeq = this.assertLocalHead(mirrored)
      if (
        mirrorSeq > remoteSeq ||
        remoteSeq > records.length ||
        records.length > remoteSeq + 1 ||
        remoteSeq > mirrorSeq + 1 ||
        records.length > mirrorSeq + 1
      ) {
        throw conflict("local, independent and database authority histories disagree")
      }
      let acknowledgedSeq = mirrorSeq
      for (let index = 0; index < mirrorSeq; index += 1) {
        if (!(await this.hasAcknowledgement(records[index]!))) {
          if (index !== mirrorSeq - 1 || records.length > mirrorSeq)
            throw conflict("observed acknowledgement is missing inside committed history")
          acknowledgedSeq = index
        }
      }
      this.confirmed = acknowledgedSeq
      if (records.length > acknowledgedSeq) {
        this.pending = records[acknowledgedSeq]!
        this.pendingRequiresConfirmation = true
      }
      for (let index = 0; index < remoteSeq; index += 1) await this.verifyRecord(records[index]!)
      for (let index = 0; index < mirrorSeq; index += 1) {
        await this.verifyMirrorRecord(records[index]!)
      }
    } catch (error) {
      // A failed initialization must never leave a local-only record looking
      // confirmed on retry. Reconstruct every head from durable sources again.
      this.records = null
      this.pending = null
      this.pendingRequiresConfirmation = false
      this.confirmed = 0
      this.byEvent.clear()
      throw error
    }
  }

  private acknowledgementBytes(record: JournalRecord<AuthorityEvent<T>>): Buffer {
    const unsigned = {
      schema: "lyrashield-supervisor-observed-mirror-ack/1",
      head: this.headFor(record),
    }
    return Buffer.from(canonicalJson({ ...unsigned, signature: this.sign(unsigned) }))
  }

  private async hasAcknowledgement(
    record: JournalRecord<AuthorityEvent<T>>,
    bounded = false
  ): Promise<boolean> {
    const bytes = this.acknowledgementBytes(record)
    const key = `${this.prefix}/acknowledgements/${record.sequence}`
    const store = this.options.store as BoundedConditionalObjectStore
    const object = bounded ? await store.readBounded(key, bytes.byteLength) : await store.read(key)
    if (!object) return false
    if (!Buffer.from(object.bytes).equals(bytes))
      throw conflict("observed mirror acknowledgement is changed or foreign")
    return true
  }

  private async verifyRecord(record: JournalRecord<AuthorityEvent<T>>): Promise<void> {
    const object = await this.options.store.read(`${this.prefix}/records/${record.sequence}`)
    if (!object) throw unknown("independent record readback is unavailable")
    if (!Buffer.from(object.bytes).equals(this.recordBytes(record))) {
      throw conflict("independent record differs from the durable local intent")
    }
  }

  private async verifyMirrorRecord(record: JournalRecord<AuthorityEvent<T>>): Promise<void> {
    const mirrored = await this.options.mirror.readRecord(record.sequence)
    if (!mirrored) throw unknown("database record readback is unavailable")
    if (!same(mirrored, record))
      throw conflict("database record differs from the durable local intent")
  }

  private async assertConfirmed(): Promise<void> {
    await this.assertHeads(this.confirmed)
    for (const record of this.records!.slice(0, this.confirmed)) {
      if (!(await this.hasAcknowledgement(record)))
        throw unknown("observed mirror acknowledgement is unavailable")
    }
  }

  private async assertHeads(sequence: number): Promise<void> {
    const local = await this.options.local.load()
    if (!same(local, this.records)) {
      throw conflict("local authority history changed outside the active writer")
    }
    const remote = await this.readRemoteHead()
    const mirror = await this.readMirrorHead()
    const expected = sequence ? this.headFor(this.records![sequence - 1]!) : null
    if (!same(remote?.head ?? null, expected) || !same(mirror, expected)) {
      throw conflict("authority heads changed outside the active writer")
    }
    for (let index = 0; index < sequence; index += 1) {
      await this.verifyRecord(this.records![index]!)
      await this.verifyMirrorRecord(this.records![index]!)
    }
  }

  private async persist(record: JournalRecord<AuthorityEvent<T>>): Promise<void> {
    const expected = this.headFor(record)
    const previous = this.confirmed ? this.headFor(this.records![this.confirmed - 1]!) : null
    let remote = await this.readRemoteHead()
    if (!same(remote?.head ?? null, previous) && !same(remote?.head ?? null, expected)) {
      throw conflict("independent head changed while replaying an intent")
    }
    const key = `${this.prefix}/records/${record.sequence}`
    const bytes = this.recordBytes(record)
    if (!same(remote?.head ?? null, expected)) {
      await this.options.store.put(key, bytes, { ifNoneMatch: true })
      await this.verifyRecord(record)
      const condition = remote ? { ifMatch: remote.etag } : { ifNoneMatch: true as const }
      await this.options.store.put(
        `${this.prefix}/head`,
        Buffer.from(canonicalJson(expected)),
        condition
      )
      remote = await this.readRemoteHead()
      if (!remote) throw unknown("independent head readback is unavailable")
      if (!same(remote.head, expected)) throw conflict("independent head does not match the intent")
    } else {
      await this.verifyRecord(record)
    }
    const mirrored = await this.readMirrorHead()
    if (!same(mirrored, previous) && !same(mirrored, expected)) {
      throw conflict("database mirror changed while replaying an intent")
    }
    // Replayed commits need an actual idempotent mirror response, not matching heads.
    const outcome = await this.options.mirror.compareAndAppend(previous, expected, record)
    if (outcome !== "written") throw conflict("database mirror rejected the intent")
    const readback = await this.readMirrorHead()
    if (!readback) throw unknown("database mirror readback is unavailable")
    if (!same(readback, expected)) throw conflict("database mirror does not match the intent")
  }
}
