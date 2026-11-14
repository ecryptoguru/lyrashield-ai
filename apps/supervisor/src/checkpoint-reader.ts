import {
  IndependentAuthorityError,
  MAX_SUPERVISOR_JOURNAL_PAGE_BYTES,
  bindSupervisorJournalSnapshot,
  canonicalJson,
  headSchema,
  supervisorJournalCursorSchema,
  verifyJournalRecord,
  type AuthorityHead,
  type SupervisorJournalPage,
  type SupervisorJournalReader,
} from "@lyrashield/runtime-control"
import { supervisorJournalEventSchema, type SupervisorJournalEvent } from "./journal-events"
import {
  CHECKPOINT_GENESIS,
  CHECKPOINT_LIMITS,
  checkpointFailure,
  checkpointSame,
  checkpointSign,
  verifyCheckpoint,
  verifyCheckpointRecord,
  verifyCheckpointSegment,
  type CheckpointRecord,
  type SupervisorCheckpoint,
} from "./checkpoint-format"
import {
  checkpointStreamAuthoritySchema,
  type CheckpointStreamAuthority,
  type SupervisorCheckpointReaderOptions,
} from "./checkpoint-ports"

type Snapshot = {
  original: unknown | null
  wrapper: CheckpointRecord | null
  checkpoint: SupervisorCheckpoint | null
  remote: AuthorityHead | null
  mirror: AuthorityHead | null
}
function boundedJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit)
    checkpointFailure("READ_LIMIT", "checkpoint evidence exceeds byte limit")
  return JSON.parse(Buffer.from(bytes).toString("utf8"))
}
function boundedValue(value: unknown, limit: number): void {
  if (Buffer.byteLength(canonicalJson(value)) > limit)
    checkpointFailure("READ_LIMIT", "checkpoint evidence exceeds byte limit")
}
function localHeadFor(
  record: CheckpointRecord,
  options: SupervisorCheckpointReaderOptions
): AuthorityHead {
  const { epochId, operationId, scanId, workspaceId, attemptId, eventId } = record.payload
  const body = {
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
  return { ...body, signature: checkpointSign(options.wrapperSigningSecret, body) }
}
function verifiedHead(
  value: unknown | null,
  options: SupervisorCheckpointReaderOptions
): AuthorityHead | null {
  if (value === null) return null
  boundedValue(value, CHECKPOINT_LIMITS.metadataBytes)
  const parsed = headSchema.safeParse(value)
  if (!parsed.success) checkpointFailure("CHECKPOINT_CONFLICT", "authority head shape differs")
  const head = parsed.data,
    { signature, ...body } = head
  if (
    signature !== checkpointSign(options.wrapperSigningSecret, body) ||
    head.epochId !== options.epochId ||
    head.supervisorInstanceId !== options.supervisorInstanceId
  )
    checkpointFailure("CHECKPOINT_CONFLICT", "authority head signature or stream differs")
  return head
}

/**
 * Closed checkpoint foundation. No append/recovery/publication method or writer
 * serialization is available here; protected native ports must be qualified first.
 */
export class SupervisorCheckpointReader implements SupervisorJournalReader<SupervisorJournalEvent> {
  private readonly prefix: string
  private observed: CheckpointStreamAuthority | null = null
  constructor(private readonly options: SupervisorCheckpointReaderOptions) {
    supervisorJournalCursorSchema.parse({
      epochId: options.epochId,
      supervisorInstanceId: options.supervisorInstanceId,
      afterSequence: 0,
      afterHash: CHECKPOINT_GENESIS,
      limit: 1,
    })
    for (const secret of [
      options.originalSigningSecret,
      options.wrapperSigningSecret,
      options.checkpointSigningSecret,
    ])
      checkpointSign(secret, {})
    if (
      !options.local?.readHeads ||
      !options.local.readCheckpointAt ||
      !options.local.readSegment ||
      !options.store?.readBounded ||
      !options.mirror?.readCheckpoint ||
      !options.mirror.readHead ||
      !options.mirror.readRecord ||
      !options.trust?.readStream ||
      !options.trust.confirmCheckpoint ||
      !options.trust.authorizeRecord
    )
      checkpointFailure("CHECKPOINT_REQUIRED", "protected bounded checkpoint ports are unavailable")
    this.prefix = `epochs/${options.epochId}/supervisors/${options.supervisorInstanceId}`
  }

  private async authority(): Promise<CheckpointStreamAuthority> {
    const value = await this.options.trust.readStream({
      epochId: this.options.epochId,
      supervisorInstanceId: this.options.supervisorInstanceId,
    })
    boundedValue(value, CHECKPOINT_LIMITS.metadataBytes)
    const parsed = checkpointStreamAuthoritySchema.safeParse(value)
    if (!parsed.success)
      checkpointFailure("AUTHORITY_CONFLICT", "active persisted stream authority is unavailable")
    const authority = parsed.data
    if (
      authority.epochId !== this.options.epochId ||
      authority.supervisorInstanceId !== this.options.supervisorInstanceId
    )
      checkpointFailure("AUTHORITY_CONFLICT", "persisted stream authority differs")
    this.assertMonotonic(authority)
    return authority
  }

  private assertMonotonic(authority: CheckpointStreamAuthority): void {
    const prior = this.observed
    if (
      prior &&
      (authority.revision < prior.revision ||
        authority.confirmedSequence < prior.confirmedSequence ||
        (authority.confirmedSequence === prior.confirmedSequence &&
          ["originalHash", "wrapperHash", "checkpointHash"].some(
            (key) => authority[key as "originalHash"] !== prior[key as "originalHash"]
          )) ||
        (authority.confirmedSequence > prior.confirmedSequence &&
          authority.revision <= prior.revision))
    )
      checkpointFailure(
        "CHECKPOINT_ROLLBACK",
        "persisted checkpoint authority rolled back or forked"
      )
  }

  private commitObservation(authority: CheckpointStreamAuthority): void {
    // No await may separate this comparison from assignment: another read can
    // commit a newer observation after asynchronous authority validation returns.
    this.assertMonotonic(authority)
    this.observed = authority
  }

  private async snapshot(authority: CheckpointStreamAuthority): Promise<Snapshot> {
    const [local, object, mirrored] = await Promise.all([
      this.options.local.readHeads(CHECKPOINT_LIMITS.localHeadBytes),
      this.options.store.readBounded(`${this.prefix}/head`, CHECKPOINT_LIMITS.metadataBytes),
      this.options.mirror.readHead(CHECKPOINT_LIMITS.metadataBytes),
    ])
    boundedValue(local, CHECKPOINT_LIMITS.localHeadBytes)
    const remote = object
      ? verifiedHead(boundedJson(object.bytes, CHECKPOINT_LIMITS.metadataBytes), this.options)
      : null
    const mirror = verifiedHead(mirrored, this.options)
    if (!authority.confirmedSequence) {
      if (
        local.original ||
        local.wrapper ||
        local.checkpoint ||
        remote ||
        mirror ||
        [authority.originalHash, authority.wrapperHash, authority.checkpointHash].some(
          (hash) => hash !== CHECKPOINT_GENESIS
        )
      )
        checkpointFailure("AUTHORITY_UNKNOWN", "genesis heads or unresolved suffix differ")
      return { original: null, wrapper: null, checkpoint: null, remote, mirror }
    }
    if (!local.original || !local.wrapper || !remote || !mirror)
      checkpointFailure("AUTHORITY_UNKNOWN", "authority head or pending suffix is unavailable")
    const original = verifyJournalRecord(
      local.original,
      this.options.originalSigningSecret,
      (value) => supervisorJournalEventSchema.parse(value)
    )
    const wrapper = verifyCheckpointRecord(local.wrapper, this.options)
    if (
      !checkpointSame(original, local.original) ||
      !checkpointSame(original, wrapper.payload.payload) ||
      original.payload.supervisorInstanceId !== this.options.supervisorInstanceId ||
      wrapper.payload.epochId !== this.options.epochId
    )
      checkpointFailure("AUTHORITY_UNKNOWN", "local original and wrapper heads disagree")
    const expected = localHeadFor(wrapper, this.options)
    if (
      !checkpointSame(expected, remote) ||
      !checkpointSame(expected, mirror) ||
      original.sequence !== authority.confirmedSequence ||
      original.hash !== authority.originalHash ||
      wrapper.hash !== authority.wrapperHash
    )
      checkpointFailure(
        "AUTHORITY_UNKNOWN",
        "local, object-store, database or persisted heads disagree"
      )
    if ((await this.options.trust.authorizeRecord(wrapper, authority)) !== true)
      checkpointFailure(
        "AUTHORITY_CONFLICT",
        "persisted current head authority is revoked or mismatched"
      )
    if (!local.checkpoint)
      checkpointFailure("CHECKPOINT_REQUIRED", "current head has no confirmed checkpoint")
    const checkpoint = verifyCheckpoint(local.checkpoint, this.options.checkpointSigningSecret)
    if (
      checkpoint.checkpointHash !== authority.checkpointHash ||
      checkpoint.lastSequence !== original.sequence ||
      checkpoint.originalLastHash !== original.hash ||
      checkpoint.wrapperLastHash !== wrapper.hash
    )
      checkpointFailure("CHECKPOINT_REQUIRED", "checkpoint does not cover the current exact heads")
    return { original, wrapper, checkpoint, remote, mirror }
  }

  private async checkpointEvidence(
    checkpoint: SupervisorCheckpoint,
    authority: CheckpointStreamAuthority
  ): Promise<void> {
    const [remote, mirrored, identity] = await Promise.all([
      this.options.store.readBounded(
        `${this.prefix}/checkpoints/${checkpoint.checkpointHash}`,
        CHECKPOINT_LIMITS.metadataBytes
      ),
      this.options.mirror.readCheckpoint(
        checkpoint.checkpointHash,
        CHECKPOINT_LIMITS.metadataBytes
      ),
      this.options.trust.confirmCheckpoint(checkpoint, authority),
    ])
    if (!remote || mirrored === null || identity === null)
      checkpointFailure(
        "CHECKPOINT_REQUIRED",
        "checkpoint commit or authenticated identity is unresolved"
      )
    boundedValue(identity, 2 * CHECKPOINT_LIMITS.metadataBytes)
    boundedValue(mirrored, CHECKPOINT_LIMITS.metadataBytes)
    if (
      !checkpointSame(
        verifyCheckpoint(
          boundedJson(remote.bytes, CHECKPOINT_LIMITS.metadataBytes),
          this.options.checkpointSigningSecret
        ),
        checkpoint
      ) ||
      !checkpointSame(
        verifyCheckpoint(mirrored, this.options.checkpointSigningSecret),
        checkpoint
      ) ||
      !checkpointSame(identity, {
        schema: "lyrashield-authenticated-checkpoint/1",
        checkpoint,
        authority,
      })
    )
      checkpointFailure(
        "CHECKPOINT_CONFLICT",
        "checkpoint mirrors or persisted authenticated identity differ"
      )
    if (
      checkpoint.epochId !== authority.epochId ||
      checkpoint.supervisorInstanceId !== authority.supervisorInstanceId ||
      checkpoint.lastSequence > authority.confirmedSequence
    )
      checkpointFailure(
        "CHECKPOINT_CONFLICT",
        "checkpoint belongs to another stream or future range"
      )
  }

  private async segment(checkpoint: SupervisorCheckpoint): Promise<CheckpointRecord[]> {
    const bytes = await this.options.local.readSegment(
      checkpoint.checkpointHash,
      CHECKPOINT_LIMITS.segmentBytes
    )
    if (bytes === null)
      checkpointFailure("CHECKPOINT_REQUIRED", "local checkpoint segment is unavailable")
    return verifyCheckpointSegment(bytes, checkpoint, this.options)
  }

  private async recordEvidence(
    records: CheckpointRecord[],
    authority: CheckpointStreamAuthority
  ): Promise<void> {
    for (const record of records) {
      const body = {
        schema: "lyrashield-independent-authority-record/1",
        supervisorInstanceId: this.options.supervisorInstanceId,
        record,
      }
      const expected = Buffer.from(
        canonicalJson({
          ...body,
          signature: checkpointSign(this.options.wrapperSigningSecret, body),
        }),
        "utf8"
      )
      const [remote, mirrored, authorized] = await Promise.all([
        this.options.store.readBounded(
          `${this.prefix}/records/${record.sequence}`,
          expected.byteLength
        ),
        this.options.mirror.readRecord(record.sequence, Buffer.byteLength(canonicalJson(record))),
        this.options.trust.authorizeRecord(record, authority),
      ])
      if (!remote || mirrored === null)
        checkpointFailure("AUTHORITY_UNKNOWN", "checkpoint record durability is unresolved")
      if (
        remote.bytes.byteLength !== expected.byteLength ||
        !Buffer.from(remote.bytes).equals(expected) ||
        !checkpointSame(mirrored, record)
      )
        checkpointFailure(
          "CHECKPOINT_CONFLICT",
          "checkpoint original differs across three histories"
        )
      if (authorized !== true)
        checkpointFailure(
          "AUTHORITY_CONFLICT",
          "persisted record authority is revoked or mismatched"
        )
    }
  }

  private async read(input: unknown): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
    const parsed = supervisorJournalCursorSchema.safeParse(input)
    if (!parsed.success) checkpointFailure("INVALID_CURSOR", "invalid checkpoint cursor")
    const cursor = parsed.data
    if (
      cursor.epochId !== this.options.epochId ||
      cursor.supervisorInstanceId !== this.options.supervisorInstanceId
    )
      checkpointFailure("CURSOR_CONFLICT", "checkpoint cursor belongs to another stream")
    const authority = await this.authority(),
      before = await this.snapshot(authority)
    const snapshotCursor = bindSupervisorJournalSnapshot(cursor, before.remote)
    if (cursor.afterSequence > authority.confirmedSequence)
      checkpointFailure("CURSOR_CONFLICT", "checkpoint cursor is beyond the confirmed head")
    if (!before.checkpoint) {
      if (cursor.afterSequence || cursor.afterHash !== CHECKPOINT_GENESIS)
        checkpointFailure("CURSOR_CONFLICT", "checkpoint genesis predecessor differs")
      const after = await this.snapshot(authority),
        current = await this.authority()
      if (!checkpointSame(before, after) || !checkpointSame(authority, current))
        checkpointFailure("CURSOR_CONFLICT", "checkpoint genesis changed while read")
      this.commitObservation(current)
      return { records: [], snapshotHead: null, nextCursor: snapshotCursor, hasMore: false }
    }
    await this.checkpointEvidence(before.checkpoint, authority)
    const point = Math.min(cursor.afterSequence + 1, authority.confirmedSequence)
    const indexed = await this.options.local.readCheckpointAt(
      point,
      CHECKPOINT_LIMITS.metadataBytes
    )
    if (!indexed)
      checkpointFailure("CHECKPOINT_REQUIRED", "authenticated checkpoint index is unavailable")
    boundedValue(indexed, CHECKPOINT_LIMITS.metadataBytes)
    const checkpoint = verifyCheckpoint(indexed, this.options.checkpointSigningSecret)
    if (point < checkpoint.firstSequence || point > checkpoint.lastSequence)
      checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint index returned another range")
    if (checkpoint.checkpointHash !== before.checkpoint.checkpointHash)
      await this.checkpointEvidence(checkpoint, authority)
    const records = await this.segment(checkpoint)
    const predecessor =
      cursor.afterSequence < checkpoint.firstSequence
        ? checkpoint.originalPreviousHash
        : records[cursor.afterSequence - checkpoint.firstSequence]?.payload.payload.hash
    if (predecessor !== cursor.afterHash)
      checkpointFailure("CURSOR_CONFLICT", "checkpoint cursor predecessor differs")
    await this.recordEvidence(records, authority)
    const page: SupervisorJournalPage<SupervisorJournalEvent> = {
      records: [],
      snapshotHead: before.remote,
      nextCursor: snapshotCursor,
      hasMore: cursor.afterSequence < authority.confirmedSequence,
    }
    for (const record of records
      .filter((record) => record.sequence > cursor.afterSequence)
      .slice(0, cursor.limit)) {
      const next = {
        records: [...page.records, record],
        snapshotHead: before.remote,
        nextCursor: {
          ...snapshotCursor,
          afterSequence: record.sequence,
          afterHash: record.payload.payload.hash,
        },
        hasMore: record.sequence < authority.confirmedSequence,
      }
      if (Buffer.byteLength(canonicalJson(next)) > MAX_SUPERVISOR_JOURNAL_PAGE_BYTES) break
      Object.assign(page, next)
    }
    if (page.hasMore && !page.records.length)
      checkpointFailure("READ_LIMIT", "checkpoint page cannot make bounded progress")
    const verified = await this.segment(checkpoint)
    if (!checkpointSame(verified, records))
      checkpointFailure("CHECKPOINT_CONFLICT", "local checkpoint segment changed")
    await this.recordEvidence(records, authority)
    await this.checkpointEvidence(before.checkpoint, authority)
    if (checkpoint.checkpointHash !== before.checkpoint.checkpointHash)
      await this.checkpointEvidence(checkpoint, authority)
    const reindexed = await this.options.local.readCheckpointAt(
      point,
      CHECKPOINT_LIMITS.metadataBytes
    )
    if (!checkpointSame(reindexed, checkpoint))
      checkpointFailure("CHECKPOINT_CONFLICT", "checkpoint range index changed")
    const after = await this.snapshot(authority),
      current = await this.authority()
    if (!checkpointSame(before, after) || !checkpointSame(authority, current))
      checkpointFailure("CURSOR_CONFLICT", "checkpoint heads or authority changed while read")
    this.commitObservation(current)
    return structuredClone(page)
  }

  async readCursor(input: unknown): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
    try {
      return await this.read(input)
    } catch (error) {
      if (error instanceof IndependentAuthorityError) throw error
      throw new IndependentAuthorityError(
        "AUTHORITY_UNKNOWN",
        "checkpoint evidence is unavailable or unresolved"
      )
    }
  }
}
