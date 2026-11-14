import {
  IndependentAuthorityError,
  IndependentAuthorityJournal,
  JournalReadLimitError,
  MAX_SUPERVISOR_JOURNAL_PAGE_BYTES,
  MAX_SUPERVISOR_JOURNAL_RECORD_BYTES,
  SignedJournal,
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  bindSupervisorJournalSnapshot,
  supervisorJournalCursorSchema,
  supervisorRecoveryRequestSchema,
  type AttemptBinding,
  type AuthorityEvent,
  type IndependentAuthorityJournalOptions,
  type JournalPort,
  type JournalRecord,
  type BoundedAuthorityMirror,
  type BoundedConditionalObjectStore,
  type SupervisorJournalPage,
  type SupervisorJournalCursor,
  type SupervisorJournalReader,
  type SupervisorJournalRecovery,
  type SupervisorJournalRecoveryPort,
  type SupervisorCommand,
  type SupervisorRecoveryRequest,
} from "@lyrashield/runtime-control"
import {
  supervisorJournalEventSchema,
  supervisorJournalRecordSchema,
  type SupervisorJournalEvent,
} from "./journal-events"
import { inspectJournalPath, journalPathsOverlap } from "./journal-paths"
import { bindingFor, attemptFor, same, conflict } from "./authority-bindings"
import {
  recoverSignedEvent,
  RecoverySelectionError,
  validRecoveryHold,
  validRecoverySuffix,
  eventCommandId,
  type RecoveryAuthorizer,
} from "./authority-recovery"

type OriginalRecord = JournalRecord<SupervisorJournalEvent>
type OriginalEventPosition = Pick<OriginalRecord, "payload" | "sequence">
type WrappedEvent = AuthorityEvent<OriginalRecord>
type WrappedRecord = JournalRecord<WrappedEvent>

// Closed prototype safeguard. Continuing production recovery needs authenticated
// checkpoints/compaction or truly bounded paging; STOP/append have no such ceiling.
export const SUPERVISOR_CURSOR_HISTORY_LIMITS = {
  maxRecords: 64,
  originalMaxBytes: 512 * 1024,
  wrappedMaxBytes: 1024 * 1024,
} as const
type LocalSnapshot = { originals: OriginalRecord[]; wrapped: WrappedRecord[] }

type DurabilityOptions = Omit<
  IndependentAuthorityJournalOptions<OriginalRecord>,
  "local" | "payloadSchema" | "authorize" | "authorizeConfirmed"
> & {
  // Must atomically validate current persisted epoch, operation, attempt,
  // workspace, scan and authority revision. Journal evidence is not permission
  // to perform an executor or provider action.
  authorize: (event: WrappedEvent, binding: AttemptBinding) => Promise<boolean>
  authorizeConfirmed?: (record: WrappedRecord, binding: AttemptBinding) => Promise<boolean>
  // Mandatory even for genesis: authenticate the persisted active stream/epoch
  // independently of whether there are any events to authorize.
  authorizeStream: (stream: { epochId: string; supervisorInstanceId: string }) => Promise<boolean>
  // Independently compare current persisted command/attempt/epoch/grant authority;
  // request IDs/digest only select the original record and never grant permission.
  authorizeRecovery: RecoveryAuthorizer
  onConfirmed?: (record: OriginalRecord) => Promise<void>
  readOnly?: boolean
}

export interface SupervisorAuthorityJournalOptions extends DurabilityOptions {
  original: JournalPort<SupervisorJournalEvent>
  local: JournalPort<WrappedEvent>
}

/**
 * Two signed local streams: originals remain intact, while the independent
 * stream signs wrappers containing those exact originals. Reads never repair
 * incomplete durability. Only append of the same pending payload can replay it.
 */
export class SupervisorAuthorityJournal
  implements
    JournalPort<SupervisorJournalEvent>,
    SupervisorJournalReader<SupervisorJournalEvent>,
    SupervisorJournalRecoveryPort<SupervisorJournalEvent>
{
  private readonly independent: IndependentAuthorityJournal<OriginalRecord>
  private serial: Promise<void> = Promise.resolve()
  private failed: IndependentAuthorityError | null = null
  private originals: OriginalRecord[] | null = null
  private cursorOriginals: OriginalRecord[] | null = null
  private readonly cursorBindings = new Map<string, { binding: AttemptBinding; sequence: number }>()
  private rangeRead = false
  private boundedRead = false
  private recoveryAuthority: {
    request: SupervisorRecoveryRequest
    original: OriginalRecord
    command: SupervisorCommand
    binding: AttemptBinding
  } | null = null

  constructor(private readonly options: SupervisorAuthorityJournalOptions) {
    const { authorizeConfirmed, ...independentOptions } = options
    this.independent = new IndependentAuthorityJournal({
      ...independentOptions,
      local: {
        load: () => this.loadLocal(),
        append: (event) => options.local.append(event),
        ...(options.local.readRange
          ? {
              readRange: (afterSequence, limits) => options.local.readRange!(afterSequence, limits),
            }
          : {}),
        ...(options.local.confirmRecord
          ? {
              confirmRecord: (record: WrappedRecord) => options.local.confirmRecord!(record),
            }
          : {}),
      },
      payloadSchema: supervisorJournalRecordSchema,
      authorize: async (event) => {
        const originals = this.originals
        if (!originals)
          throw new IndependentAuthorityError(
            "AUTHORITY_UNKNOWN",
            "no authenticated local snapshot"
          )
        const original = originals[event.payload.sequence - 1]
        if (!original || !same(original, event.payload)) {
          conflict("independent event differs from its original signed envelope")
        }
        const binding = this.rangeRead
          ? this.cursorBindingFor(original)
          : bindingFor(original, originals)
        const expected = this.eventFor(original, originals, binding)
        if (!same(event, expected)) conflict("independent event has a foreign authority binding")
        const recovery = this.recoveryAuthority
        if (
          recovery &&
          (same(original, recovery.original) ||
            validRecoveryHold(original.payload, recovery.original, originals))
        ) {
          return options.authorizeRecovery(
            recovery.request,
            recovery.original,
            recovery.command,
            recovery.binding
          )
        }
        return options.authorize(event, binding)
      },
      ...(authorizeConfirmed
        ? {
            authorizeConfirmed: async (record: WrappedRecord) => {
              const originals = this.originals
              if (!originals)
                throw new IndependentAuthorityError(
                  "AUTHORITY_UNKNOWN",
                  "no authenticated local snapshot"
                )
              const original = originals[record.payload.payload.sequence - 1]
              if (!original || !same(original, record.payload.payload))
                conflict("confirmed event differs from its original signed envelope")
              const binding = this.rangeRead
                ? this.cursorBindingFor(original)
                : bindingFor(original, originals)
              if (!same(record.payload, this.eventFor(original, originals, binding)))
                conflict("confirmed event has a foreign authority binding")
              return authorizeConfirmed(record, binding)
            },
          }
        : {}),
    })
  }

  private serialized<T>(operation: () => Promise<T>, snapshot?: LocalSnapshot): Promise<T> {
    const run = this.serial.then(async () => {
      if (this.failed) throw this.failed
      this.originals = snapshot?.originals ?? null
      this.boundedRead = !!snapshot
      try {
        return await operation()
      } catch (error) {
        if (error instanceof IndependentAuthorityError) {
          if (error.code === "AUTHORITY_CONFLICT") this.failed = error
          throw error
        }
        throw new IndependentAuthorityError("AUTHORITY_UNKNOWN", "supervisor journal is unresolved")
      } finally {
        this.originals = null
        this.boundedRead = false
        this.rangeRead = false
        this.recoveryAuthority = null
      }
    })
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async assertStreamAuthorized(): Promise<void> {
    try {
      if (
        !(await this.options.authorizeStream({
          epochId: this.options.epochId,
          supervisorInstanceId: this.options.supervisorInstanceId,
        }))
      ) {
        this.failed = new IndependentAuthorityError(
          "AUTHORITY_CONFLICT",
          "persisted stream or epoch is revoked"
        )
        throw this.failed
      }
    } catch (error) {
      if (error instanceof IndependentAuthorityError) throw error
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "persisted stream authority is unavailable"
      )
    }
  }

  private async loadOriginal(): Promise<OriginalRecord[]> {
    if (this.boundedRead) return this.boundedOriginal()
    const records = await this.options.original.load()
    this.cursorOriginals = records
    this.cursorBindings.clear()
    for (const record of records) {
      const event = record.payload
      if (event.type !== "command_intent" || event.command.type !== "PREPARE") continue
      const binding = event.command.attempt
      const prior = this.cursorBindings.get(binding.attemptId)
      if (prior && !same(prior.binding, binding))
        conflict("original journal has conflicting attempt authority")
      if (!prior) this.cursorBindings.set(binding.attemptId, { binding, sequence: record.sequence })
    }
    return records
  }

  private cursorBindingFor(record: OriginalRecord): AttemptBinding {
    const entry = this.cursorBindings.get(attemptFor(record))
    if (!entry || entry.sequence > record.sequence)
      conflict("range has no preceding attempt authority")
    if (
      record.payload.type === "attempt_prepared" &&
      !same(entry.binding, record.payload.binding)
    ) {
      conflict("range prepared event differs from attempt authority")
    }
    return entry.binding
  }

  private loadLocal(): Promise<WrappedRecord[]> {
    return this.boundedRead ? this.boundedLocal() : this.options.local.load()
  }

  private async boundedOriginal(): Promise<OriginalRecord[]> {
    if (!this.options.original.loadBounded)
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "bounded original read is unavailable"
      )
    const records = await this.options.original.loadBounded({
      maxBytes: SUPERVISOR_CURSOR_HISTORY_LIMITS.originalMaxBytes,
      maxRecords: SUPERVISOR_CURSOR_HISTORY_LIMITS.maxRecords,
    })
    this.assertCursorCeiling(records, SUPERVISOR_CURSOR_HISTORY_LIMITS.originalMaxBytes)
    return records
  }

  private async boundedLocal(): Promise<WrappedRecord[]> {
    if (!this.options.local.loadBounded)
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "bounded wrapper read is unavailable"
      )
    const records = await this.options.local.loadBounded({
      maxBytes: SUPERVISOR_CURSOR_HISTORY_LIMITS.wrappedMaxBytes,
      maxRecords: SUPERVISOR_CURSOR_HISTORY_LIMITS.maxRecords,
    })
    this.assertCursorCeiling(records, SUPERVISOR_CURSOR_HISTORY_LIMITS.wrappedMaxBytes)
    return records
  }

  private assertCursorCeiling(records: unknown[], maxBytes: number): void {
    if (
      records.length > SUPERVISOR_CURSOR_HISTORY_LIMITS.maxRecords ||
      Buffer.byteLength(canonicalJson(records)) > maxBytes
    ) {
      throw new JournalReadLimitError("cursor snapshot exceeds read ceiling")
    }
  }

  private async captureCursorSnapshot(): Promise<LocalSnapshot> {
    // This capped capture happens before the cursor joins STOP/append serialization.
    // A limit rejection must neither latch the writer nor discard existing history.
    try {
      return { originals: await this.boundedOriginal(), wrapped: await this.boundedLocal() }
    } catch (error) {
      if (error instanceof JournalReadLimitError) {
        throw new IndependentAuthorityError(
          "READ_LIMIT",
          "cursor history exceeds prototype read ceiling"
        )
      }
      if (error instanceof IndependentAuthorityError) throw error
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "bounded signed snapshot is unavailable"
      )
    }
  }

  private eventFor(
    record: OriginalRecord,
    originals: OriginalRecord[],
    binding = bindingFor(record, originals)
  ): WrappedEvent {
    if (
      binding.authorityEpochId !== this.options.epochId ||
      record.payload.supervisorInstanceId !== this.options.supervisorInstanceId
    ) {
      conflict("original event belongs to a foreign epoch or supervisor")
    }
    return {
      epochId: binding.authorityEpochId,
      operationId: binding.operationId,
      scanId: binding.scanId,
      workspaceId: binding.workspaceId,
      attemptId: binding.attemptId,
      eventId: `supervisor:${record.hash}`,
      payload: record,
    }
  }

  private async localHistory(): Promise<{ originals: OriginalRecord[]; wrapped: WrappedRecord[] }> {
    const originals = this.originals ?? (await this.loadOriginal())
    this.originals = originals
    const wrapped = await this.loadLocal()
    const guardedSuffix = originals.length === wrapped.length + 2 && validRecoverySuffix(originals)
    if (
      wrapped.length > originals.length ||
      (originals.length > wrapped.length + 1 && !guardedSuffix)
    ) {
      conflict("original and independent local streams disagree")
    }
    if (guardedSuffix) this.eventFor(originals.at(-1)!, originals)
    for (const [index, record] of wrapped.entries()) {
      const original = originals[index]
      if (!original || !same(record.payload, this.eventFor(original, originals))) {
        conflict("independent wrapper changed the original envelope or authority binding")
      }
    }
    return { originals, wrapped }
  }

  private async confirmedHistory(): Promise<WrappedRecord[]> {
    await this.assertStreamAuthorized()
    const { originals, wrapped } = await this.localHistory()
    const confirmed = await this.independent.loadConfirmed()
    if (originals.length !== confirmed.length) {
      throw new IndependentAuthorityError("REPLAY_REQUIRED", "replay the original pending event")
    }
    if (!same(wrapped, confirmed) || !same(originals, await this.loadOriginal())) {
      conflict("signed supervisor history changed during readback")
    }
    await this.assertStreamAuthorized()
    return confirmed
  }

  async load(): Promise<OriginalRecord[]> {
    return this.serialized(async () =>
      (await this.confirmedHistory()).map((record) => structuredClone(record.payload.payload))
    )
  }

  async append(input: SupervisorJournalEvent): Promise<OriginalRecord> {
    if (this.options.readOnly) conflict("Publication journal is read-only")
    const record = await this.serialized(() => this.appendCurrent(input))
    // Installed receipt projection reads this journal; run after releasing its
    // serialization queue so private readback cannot deadlock the append.
    await this.options.onConfirmed?.(record)
    return record
  }

  private async stageRecoveryHold(
    input: SupervisorJournalEvent,
    originals: OriginalRecord[]
  ): Promise<OriginalRecord> {
    const payload = supervisorJournalEventSchema.parse(input)
    if (!validRecoveryHold(payload, originals.at(-1), originals))
      throw new RecoverySelectionError("recovery guard does not bind the current original tail")
    const record = await this.options.original.append(payload)
    const history = [...originals, record]
    if (!validRecoverySuffix(history)) conflict("invalid local recovery guard")
    this.eventFor(record, history)
    this.originals = history
    this.cursorOriginals = history
    return record
  }

  private async appendCurrent(input: SupervisorJournalEvent): Promise<OriginalRecord> {
    await this.assertStreamAuthorized()
    const payload = supervisorJournalEventSchema.parse(input)
    if (Buffer.byteLength(canonicalJson(payload)) > MAX_SUPERVISOR_JOURNAL_RECORD_BYTES - 1024) {
      throw new IndependentAuthorityError("RECORD_TOO_LARGE", "supervisor event exceeds read limit")
    }
    const { originals } = await this.localHistory()
    let pending: OriginalRecord | undefined
    try {
      const confirmed = await this.independent.loadConfirmed()
      if (originals.length > confirmed.length) pending = originals.at(-1)
    } catch (error) {
      if (!(error instanceof IndependentAuthorityError) || error.code !== "REPLAY_REQUIRED") {
        throw error
      }
      pending = originals.at(-1)
      if (!pending) conflict("pending independent event has no original")
    }
    if (pending && !same(pending.payload, payload)) {
      throw new IndependentAuthorityError("IDENTITY_CONFLICT", "replay the same original payload")
    }
    // Validate local epoch/binding before signing a new original. Persisted
    // authorization uses the actual signed original, never a synthetic receipt.
    const candidate: OriginalEventPosition = pending ?? {
      sequence: originals.length + 1,
      payload,
    }
    const candidateHistory = pending ? originals : [...originals, candidate]
    const candidateBinding = bindingFor(candidate, candidateHistory)
    if (
      candidateBinding.authorityEpochId !== this.options.epochId ||
      payload.supervisorInstanceId !== this.options.supervisorInstanceId
    ) {
      conflict("original event belongs to a foreign epoch or supervisor")
    }
    if (pending && !this.options.original.confirmRecord) {
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "pending original requires explicit fsync confirmation"
      )
    }
    const original = pending
      ? await this.options.original.confirmRecord!(pending)
      : await this.options.original.append(payload)
    if (pending && !same(original, pending)) {
      conflict("original replay confirmation changed the signed envelope")
    }
    const history = pending ? originals : [...originals, original]
    this.originals = history
    this.cursorOriginals = history
    const event = this.eventFor(original, history)
    await this.independent.appendIntent(event)
    await this.confirmedHistory()
    return structuredClone(original)
  }

  async recoverStored(input: unknown): Promise<SupervisorJournalRecovery<SupervisorJournalEvent>> {
    if (this.options.readOnly) conflict("Publication journal is read-only")
    const parsed =
      input === undefined ? undefined : supervisorRecoveryRequestSchema.safeParse(input)
    if (parsed && !parsed.success)
      throw new IndependentAuthorityError("INVALID_RECOVERY", "invalid recovery selector")
    return this.serialized(() =>
      recoverSignedEvent(
        {
          localHistory: () => this.localHistory(),
          confirmedCount: async () => (await this.independent.loadConfirmed()).length,
          confirmedHistory: () => this.confirmedHistory(),
          bindingFor,
          confirmPending: async (record, originals) => {
            if (!this.options.original.confirmRecord)
              throw new IndependentAuthorityError(
                "AUTHORITY_UNKNOWN",
                "original fsync confirmation is unavailable"
              )
            const confirmed = await this.options.original.confirmRecord(record)
            if (!same(confirmed, record)) conflict("recovery changed the original signed record")
            this.originals = originals
            await this.independent.appendIntent(this.eventFor(record, originals))
          },
          stageHold: (event, originals) => this.stageRecoveryHold(event, originals),
          assertStreamAuthorized: () => this.assertStreamAuthorized(),
          authorizeRecord: async (record, originals) => {
            const binding = bindingFor(record, originals)
            if (!this.options.authorizeConfirmed)
              return this.options.authorize(this.eventFor(record, originals), binding)
            const id = eventCommandId(record.payload)
            const intent = originals.find(
              (item) =>
                item.payload.type === "command_intent" && item.payload.command.commandId === id
            )
            if (!intent || intent.payload.type !== "command_intent")
              conflict("recovery has no original command")
            const command = intent.payload.command
            const request: SupervisorRecoveryRequest = {
              epochId: binding.authorityEpochId,
              supervisorInstanceId: record.payload.supervisorInstanceId,
              workspaceId: binding.workspaceId,
              scanId: binding.scanId,
              operationId: binding.operationId,
              attemptId: binding.attemptId,
              commandId: command.commandId,
              expectedCommandHash: sha256Hex(canonicalJson(command)),
            }
            if (!(await this.options.authorizeRecovery(request, record, command, binding)))
              return false
            this.recoveryAuthority = { request, original: record, command, binding }
            return true
          },
          authorizeRecovery: this.options.authorizeRecovery,
        },
        parsed?.data
      )
    )
  }

  async recoverPending(): Promise<SupervisorJournalRecovery<SupervisorJournalEvent>> {
    return this.recoverStored(undefined)
  }

  /** Root sealing keeps the authenticated snapshot alive and excludes local appends. */
  async withPublication<T>(
    operation: (ports: {
      original: JournalPort<SupervisorJournalEvent>
      wrapper: JournalPort<WrappedEvent>
      independent: IndependentAuthorityJournal<OriginalRecord>
      validateOriginal: typeof supervisorJournalEventSchema.parse
    }) => Promise<T>
  ): Promise<T> {
    return this.serialized(async () => {
      const before = await this.confirmedHistory()
      const result = await operation({
        original: this.options.original,
        wrapper: this.options.local,
        independent: this.independent,
        validateOriginal: supervisorJournalEventSchema.parse,
      })
      if (!same(before, await this.confirmedHistory()))
        conflict("journal authority changed during seal publication")
      return result
    })
  }

  async readCursor(input: unknown): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
    const parsed = supervisorJournalCursorSchema.safeParse(input)
    if (!parsed.success) {
      throw new IndependentAuthorityError("INVALID_CURSOR", "invalid supervisor journal cursor")
    }
    const cursor = parsed.data
    if (
      cursor.epochId !== this.options.epochId ||
      cursor.supervisorInstanceId !== this.options.supervisorInstanceId
    ) {
      throw new IndependentAuthorityError("CURSOR_CONFLICT", "cursor belongs to another stream")
    }
    if (this.failed) throw this.failed
    if (
      this.options.original.readRange &&
      this.options.local.readRange &&
      (this.options.store as BoundedConditionalObjectStore).readBounded &&
      (this.options.mirror as BoundedAuthorityMirror).readHeadBounded &&
      (this.options.mirror as BoundedAuthorityMirror).readRecordBounded
    ) {
      return this.serialized(async () => {
        await this.assertStreamAuthorized()
        if (!this.cursorOriginals) await this.confirmedHistory()
        if (cursor.afterSequence > this.cursorOriginals!.length) {
          throw new IndependentAuthorityError(
            "CURSOR_CONFLICT",
            "cursor is beyond the current head"
          )
        }
        this.originals = this.cursorOriginals
        this.rangeRead = true
        const originals = await this.options.original.readRange!(cursor.afterSequence, {
          maxBytes: 1024 * 1024,
          maxRecords: cursor.limit,
        })
        if (originals.previousHash !== cursor.afterHash) {
          throw new IndependentAuthorityError(
            "CURSOR_CONFLICT",
            "cursor predecessor does not match"
          )
        }
        if (!same(originals.head, this.cursorOriginals!.at(-1) ?? null)) {
          conflict("original range head changed outside the supervisor")
        }
        const confirmed = await this.independent.loadConfirmedRange(cursor.afterSequence, {
          maxBytes: 2 * 1024 * 1024,
          maxRecords: originals.records.length || cursor.limit,
        })
        if (
          !same(confirmed.head?.payload.payload ?? null, originals.head) ||
          !same(
            confirmed.records.map((record) => record.payload.payload),
            originals.records
          )
        ) {
          conflict("bounded original and independent streams disagree")
        }
        const snapshotHead = this.independent.confirmedHead()
        const snapshotCursor = bindSupervisorJournalSnapshot(cursor, snapshotHead)
        const page: SupervisorJournalPage<SupervisorJournalEvent> = {
          records: [],
          snapshotHead,
          nextCursor: snapshotCursor,
          hasMore: originals.hasMore,
        }
        for (const record of confirmed.records) {
          const next = {
            records: [...page.records, record],
            snapshotHead,
            nextCursor: {
              ...snapshotCursor,
              afterSequence: record.sequence,
              afterHash: record.payload.payload.hash,
            },
            hasMore: record.sequence < (originals.head?.sequence ?? 0),
          }
          if (Buffer.byteLength(canonicalJson(next)) > MAX_SUPERVISOR_JOURNAL_PAGE_BYTES) {
            if (!page.records.length)
              throw new IndependentAuthorityError("READ_LIMIT", "page cannot make bounded progress")
            break
          }
          Object.assign(page, next)
        }
        if (
          !same(
            originals,
            await this.options.original.readRange!(cursor.afterSequence, {
              maxBytes: 1024 * 1024,
              maxRecords: cursor.limit,
            })
          )
        )
          conflict("original range changed during readback")
        await this.assertStreamAuthorized()
        return page
      })
    }
    return this.readFallbackCursor(cursor)
  }

  private async readFallbackCursor(
    cursor: SupervisorJournalCursor
  ): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
    await this.assertStreamAuthorized()
    const snapshot = await this.captureCursorSnapshot()
    return this.serialized(async () => {
      if (
        !same(snapshot.originals, await this.boundedOriginal()) ||
        !same(snapshot.wrapped, await this.boundedLocal())
      ) {
        throw new IndependentAuthorityError(
          "CURSOR_CONFLICT",
          "cursor snapshot changed while queued; retry readback"
        )
      }
      const history = await this.confirmedHistory()
      const previous = cursor.afterSequence
        ? history[cursor.afterSequence - 1]?.payload.payload
        : null
      if (
        cursor.afterSequence > history.length ||
        cursor.afterHash !== (previous?.hash ?? "0".repeat(64))
      ) {
        throw new IndependentAuthorityError("CURSOR_CONFLICT", "cursor predecessor does not match")
      }
      const snapshotHead = this.independent.confirmedHead()
      const snapshotCursor = bindSupervisorJournalSnapshot(cursor, snapshotHead)
      const page: SupervisorJournalPage<SupervisorJournalEvent> = {
        records: [],
        snapshotHead,
        nextCursor: snapshotCursor,
        hasMore: cursor.afterSequence < history.length,
      }
      for (const record of history.slice(
        cursor.afterSequence,
        cursor.afterSequence + cursor.limit
      )) {
        const candidate = {
          records: [...page.records, record],
          snapshotHead,
          nextCursor: {
            ...snapshotCursor,
            afterSequence: record.payload.payload.sequence,
            afterHash: record.payload.payload.hash,
          },
          hasMore: record.payload.payload.sequence < history.length,
        }
        if (Buffer.byteLength(canonicalJson(candidate)) > MAX_SUPERVISOR_JOURNAL_PAGE_BYTES) {
          if (!page.records.length) {
            throw new IndependentAuthorityError(
              "RECORD_TOO_LARGE",
              "original record exceeds read limit"
            )
          }
          break
        }
        Object.assign(page, candidate)
      }
      return structuredClone(page)
    }, snapshot)
  }
}

/** Explicit protected dependencies are mandatory; there is no local-only fallback. */
export function createSupervisorAuthorityJournal(
  options: DurabilityOptions & {
    originalPath: string
    independentPath: string
    originalSigningSecret: string
  }
): { journal: SupervisorAuthorityJournal; close: () => Promise<void> } {
  if (
    journalPathsOverlap(
      inspectJournalPath(options.originalPath),
      inspectJournalPath(options.independentPath)
    )
  ) {
    throw new Error(
      "original and independent journals require separate files and namespaces, including case variants"
    )
  }
  const original = new SignedJournal(options.originalPath, options.originalSigningSecret, (value) =>
    supervisorJournalEventSchema.parse(value)
  )
  const local = new SignedJournal(options.independentPath, options.signingSecret, (value) =>
    authorityEventSchema(supervisorJournalRecordSchema).parse(value)
  )
  return {
    journal: new SupervisorAuthorityJournal({ ...options, original, local }),
    close: async () => {
      await original.close()
      await local.close()
    },
  }
}
