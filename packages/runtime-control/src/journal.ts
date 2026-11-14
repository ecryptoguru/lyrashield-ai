import { constants, type Stats, type BigIntStats } from "node:fs"
import { lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { canonicalJson } from "./canonical-json"
import { readIndexedJournalRange } from "./journal-range"
import {
  readJournalSegments,
  type JournalSegment as Segment,
  type SegmentRangeIndex,
} from "./journal-segments"
import {
  JournalIntegrityError,
  JournalReadLimitError,
  recordHash,
  signRecord,
  secureEqual,
  validateSecret,
  type JournalRecord,
} from "./journal-record"
export { JournalIntegrityError, JournalReadLimitError, verifyJournalRecord } from "./journal-record"
export type { JournalRecord } from "./journal-record"

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024

export interface JournalPort<T> {
  append(payload: T): Promise<JournalRecord<T>>
  load(): Promise<JournalRecord<T>[]>
  /** Explicitly fsync an existing exact record without appending or re-signing it. */
  confirmRecord?(record: JournalRecord<T>): Promise<JournalRecord<T>>
  loadBounded?(limits: JournalReadLimits): Promise<JournalRecord<T>[]>
  /** Indexed read from the authenticated active writer; startup still verifies the full chain. */
  readRange?(afterSequence: number, limits: JournalReadLimits): Promise<JournalRange<T>>
  /** Return the unchanged on-disk bytes of the verified range, including record newlines. */
  readRawRange?(afterSequence: number, limits: JournalReadLimits): Promise<JournalRawRange<T>>
}

export interface JournalRange<T> {
  records: JournalRecord<T>[]
  head: JournalRecord<T> | null
  previousHash: string
  hasMore: boolean
}

export interface JournalRawRange<T> {
  range: JournalRange<T>
  records: Uint8Array[]
  endPosition?: { segmentStartSequence: number; byteOffsetAfterLastSealedRecord: number }
}

export interface JournalReadLimits {
  maxBytes: number
  maxRecords: number
}

export class SignedJournal<T> implements JournalPort<T> {
  private loaded = false
  private nextSequence = 1
  private previousHash = "0".repeat(64)
  private serial: Promise<void> = Promise.resolve()
  // A failed write/fsync or an integrity rejection latches the journal: later
  // appends must not reuse a sequence or build on a potentially torn file.
  private failed: Error | null = null
  private closed = false
  private lockAcquired = false
  private lockIdentity: { dev: number; ino: number } | null = null
  private segments: Segment[] = []
  private rangeIndex: SegmentRangeIndex = []
  private readonly maxSegmentBytes: number

  constructor(
    private readonly path: string,
    private readonly secret: string,
    private readonly validatePayload: (value: unknown) => T,
    options: { maxSegmentBytes?: number } = {}
  ) {
    validateSecret(secret)
    this.maxSegmentBytes = options.maxSegmentBytes ?? MAX_JOURNAL_BYTES
    if (
      !Number.isSafeInteger(this.maxSegmentBytes) ||
      this.maxSegmentBytes < 1 ||
      this.maxSegmentBytes > MAX_JOURNAL_BYTES
    )
      throw new JournalIntegrityError("invalid journal segment size")
  }

  async append(payload: T): Promise<JournalRecord<T>> {
    if (this.closed) throw new JournalIntegrityError("journal is closed")
    let result: JournalRecord<T> | undefined
    let failure: unknown
    const operation = this.serial.then(async () => {
      try {
        this.assertUsable()
        await this.ensureLoaded()
        const current = await this.readAll()
        if (
          current.length + 1 !== this.nextSequence ||
          this.verifyChain(current) !== this.previousHash
        ) {
          throw new JournalIntegrityError("journal changed outside the active writer")
        }
        const unsigned: Omit<JournalRecord<T>, "hash" | "signature"> = {
          version: 1,
          sequence: this.nextSequence,
          previousHash: this.previousHash,
          payload,
        }
        const hash = recordHash(unsigned)
        const signature = signRecord(this.secret, canonicalJson({ ...unsigned, hash }))
        const record: JournalRecord<T> = { ...unsigned, hash, signature }
        await this.writeRecord(record)
        this.nextSequence += 1
        this.previousHash = hash
        result = record
      } catch (error) {
        failure = error
        this.latch(error)
      }
    })
    this.serial = operation.catch(() => undefined)
    await operation
    if (failure) throw failure
    if (!result) throw new Error("journal append produced no receipt")
    return result
  }

  async load(): Promise<JournalRecord<T>[]> {
    return this.loadWithLimits()
  }

  async loadBounded(limits: JournalReadLimits): Promise<JournalRecord<T>[]> {
    const bounds = { maxBytes: limits.maxBytes, maxRecords: limits.maxRecords }
    if (
      !Number.isSafeInteger(bounds.maxBytes) ||
      bounds.maxBytes < 1 ||
      bounds.maxBytes > MAX_JOURNAL_BYTES ||
      !Number.isSafeInteger(bounds.maxRecords) ||
      bounds.maxRecords < 1
    )
      throw new JournalReadLimitError("invalid journal read limits")
    return this.loadWithLimits(bounds)
  }

  async readRange(afterSequence: number, limits: JournalReadLimits): Promise<JournalRange<T>> {
    return (await this.readRangeInternal(afterSequence, limits, false)).range
  }

  async readRawRange(
    afterSequence: number,
    limits: JournalReadLimits
  ): Promise<JournalRawRange<T>> {
    return this.readRangeInternal(afterSequence, limits, true)
  }

  private async readRangeInternal(
    afterSequence: number,
    limits: JournalReadLimits,
    captureBytes: boolean
  ): Promise<JournalRawRange<T>> {
    const bounds = { maxBytes: limits.maxBytes, maxRecords: limits.maxRecords }
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(bounds.maxBytes) ||
      bounds.maxBytes < 1 ||
      bounds.maxBytes > MAX_JOURNAL_BYTES ||
      !Number.isSafeInteger(bounds.maxRecords) ||
      bounds.maxRecords < 1 ||
      bounds.maxRecords > 100
    )
      throw new JournalReadLimitError("invalid journal range limits")
    if (this.closed) throw new JournalIntegrityError("journal is closed")
    const run = this.serial.then(async () => {
      this.assertUsable()
      try {
        await this.ensureLoaded()
        if (afterSequence >= this.nextSequence)
          throw new JournalReadLimitError("cursor is beyond the journal head")
        await this.assertLockIdentity()
        await this.assertSegmentIndex()
        if (!this.segments.length) {
          return {
            range: { records: [], head: null, previousHash: "0".repeat(64), hasMore: false },
            records: [],
          }
        }
        const files = new Map<number, FileHandle>()
        const bytes = new Map<number, Uint8Array>()
        try {
          const range = await readIndexedJournalRange(
            async (index) => {
              const segmentIndex = this.rangeIndex[index]!.segment
              let file = files.get(segmentIndex)
              if (!file) {
                const segment = this.segments[segmentIndex]!
                // eslint-disable-next-line security/detect-non-literal-fs-filename
                file = await open(
                  segment.path,
                  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
                )
                files.set(segmentIndex, file)
                await this.assertFileIdentity(file, segment)
                this.assertIndexedStat(await file.stat({ bigint: true }), segment)
              }
              return file
            },
            this.rangeIndex,
            afterSequence,
            bounds,
            this.secret,
            this.validatePayload,
            captureBytes ? (sequence, raw) => bytes.set(sequence, raw) : undefined
          )
          for (const [index, file] of files) {
            const segment = this.segments[index]!
            this.assertIndexedStat(await file.stat({ bigint: true }), segment)
            await this.assertFileIdentity(file, segment)
          }
          await this.assertSegmentIndex()
          await this.assertLockIdentity()
          const last = range.records.at(-1)
          const position = last && captureBytes ? this.rangeIndex[last.sequence - 1] : undefined
          return {
            range,
            records: captureBytes ? range.records.map((record) => bytes.get(record.sequence)!) : [],
            ...(position
              ? {
                  endPosition: {
                    segmentStartSequence: this.segments[position.segment]!.start,
                    byteOffsetAfterLastSealedRecord: position.offset + position.length,
                  },
                }
              : {}),
          }
        } finally {
          await Promise.all([...files.values()].map((file) => file.close()))
        }
      } catch (error) {
        if (!(error instanceof JournalReadLimitError)) this.latch(error)
        throw error
      }
    })
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private statStamp(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  }

  private assertIndexedStat(stat: BigIntStats, segment: Segment): void {
    if (!segment.indexedStat || this.statStamp(stat) !== segment.indexedStat) {
      throw new JournalIntegrityError("journal changed outside the authenticated range index")
    }
  }

  private async loadWithLimits(limits?: JournalReadLimits): Promise<JournalRecord<T>[]> {
    if (this.closed) throw new JournalIntegrityError("journal is closed")
    const operation = this.serial.then(async () => {
      this.assertUsable()
      try {
        const initial = await this.ensureLoaded(limits)
        const records = initial ?? (await this.readAll(limits))
        const lastHash = this.verifyChain(records)
        if (records.length + 1 !== this.nextSequence || lastHash !== this.previousHash) {
          throw new JournalIntegrityError("journal changed outside the active writer")
        }
        return records
      } catch (error) {
        if (!(error instanceof JournalReadLimitError)) this.latch(error)
        throw error
      }
    })
    this.serial = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const operation = this.serial.then(async () => {
      this.assertUsable()
      if (!this.lockAcquired) return
      const records = await this.readAll()
      if (
        records.length + 1 !== this.nextSequence ||
        this.verifyChain(records) !== this.previousHash
      ) {
        throw new JournalIntegrityError("journal changed before handover")
      }
      await this.assertLockIdentity()
      // Only the owner of the validated lock can perform a graceful handover.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await unlink(`${this.path}.lock`)
      await this.syncDirectory()
      this.lockAcquired = false
    })
    this.serial = operation.then(
      () => undefined,
      () => undefined
    )
    try {
      await operation
    } catch (error) {
      this.latch(error)
      throw error
    }
  }

  async confirmRecord(record: JournalRecord<T>): Promise<JournalRecord<T>> {
    if (this.closed) throw new JournalIntegrityError("journal is closed")
    const operation = this.serial.then(async () => {
      this.assertUsable()
      try {
        await this.ensureLoaded()
        const records = await this.readAll()
        if (
          records.length + 1 !== this.nextSequence ||
          this.verifyChain(records) !== this.previousHash ||
          canonicalJson(records[record.sequence - 1]) !== canonicalJson(record)
        ) {
          throw new JournalIntegrityError("journal confirmation does not match the signed record")
        }
        // A successful read does not establish that a previous fsync completed.
        // Reconfirm the exact owned file and directory only during explicit replay.
        const position = this.rangeIndex[record.sequence - 1]
        if (!position) throw new JournalIntegrityError("journal confirmation record is missing")
        const segment = this.segments[position.segment]!
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const file = await open(
          segment.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        try {
          await this.assertFileIdentity(file, segment)
          await file.sync()
          await this.assertFileIdentity(file, segment)
        } finally {
          await file.close()
        }
        await this.syncDirectory()
        await this.assertLockIdentity()
        const readback = await this.readAll()
        if (
          canonicalJson(readback) !== canonicalJson(records) ||
          this.verifyChain(readback) !== this.previousHash
        ) {
          throw new JournalIntegrityError("journal changed during replay confirmation")
        }
        return structuredClone(record)
      } catch (error) {
        this.latch(error)
        throw error
      }
    })
    this.serial = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private assertUsable(): void {
    if (this.failed) throw this.failed
  }

  private latch(error: unknown): void {
    if (!this.failed) {
      this.failed =
        error instanceof Error
          ? error
          : new JournalIntegrityError(String(error ?? "journal failure"))
    }
  }

  private async ensureLoaded(limits?: JournalReadLimits): Promise<JournalRecord<T>[] | undefined> {
    if (this.loaded) return
    await this.acquireLock()
    const records = await this.readAll(limits)
    const previousHash = this.verifyChain(records)
    this.nextSequence = records.length + 1
    this.previousHash = previousHash
    this.loaded = true
    return records
  }

  private verifyChain(records: JournalRecord<T>[]): string {
    let previousHash = "0".repeat(64)
    for (const [index, record] of records.entries()) {
      const expectedSequence = index + 1
      if (record.sequence !== expectedSequence || record.previousHash !== previousHash) {
        throw new JournalIntegrityError("journal sequence or predecessor chain is invalid")
      }
      const unsigned = {
        version: record.version,
        sequence: record.sequence,
        previousHash: record.previousHash,
        payload: record.payload,
      }
      const expectedHash = recordHash(unsigned)
      const expectedSignature = signRecord(
        this.secret,
        canonicalJson({ ...unsigned, hash: expectedHash })
      )
      if (
        !secureEqual(record.hash, expectedHash) ||
        !secureEqual(record.signature, expectedSignature)
      ) {
        throw new JournalIntegrityError("journal signature or record hash is invalid")
      }
      previousHash = record.hash
    }
    return previousHash
  }

  private async acquireLock(): Promise<void> {
    if (this.lockAcquired) return
    const directory = await this.openDirectory()
    let lock: FileHandle | null = null
    try {
      // The exclusive lock is never discarded based only on PID or age.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      lock = await open(
        `${this.path}.lock`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      )
      const stat = await lock.stat()
      this.assertPrivateFile(stat)
      this.lockIdentity = { dev: stat.dev, ino: stat.ino }
      await lock.writeFile(`${process.pid}\n`)
      await lock.sync()
      await directory.sync()
      this.lockAcquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new JournalIntegrityError("journal writer lock already exists")
      }
      throw error
    } finally {
      await lock?.close()
      await directory.close()
    }
  }

  private async openDirectory(): Promise<FileHandle> {
    // The parent directory must be private to the trusted service identity.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const directory = await open(
      dirname(this.path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    const stat = await directory.stat()
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      await directory.close()
      throw new JournalIntegrityError("journal directory is not owned by the service")
    }
    return directory
  }

  private async syncDirectory(): Promise<void> {
    const directory = await this.openDirectory()
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  private assertPrivateFile(stat: Stats): void {
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new JournalIntegrityError("journal file ownership or permissions are invalid")
    }
  }

  private async assertLockIdentity(): Promise<void> {
    if (!this.lockAcquired || !this.lockIdentity)
      throw new JournalIntegrityError("journal writer lock is missing")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = await lstat(`${this.path}.lock`)
    this.assertPrivateFile(stat)
    if (stat.dev !== this.lockIdentity.dev || stat.ino !== this.lockIdentity.ino) {
      throw new JournalIntegrityError("journal writer lock was replaced")
    }
  }

  private async assertFileIdentity(file: FileHandle, segment: Segment): Promise<void> {
    const stat = await file.stat()
    this.assertPrivateFile(stat)
    if (
      segment.identity &&
      (stat.dev !== segment.identity.dev || stat.ino !== segment.identity.ino)
    ) {
      throw new JournalIntegrityError("journal file was replaced")
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const current = await lstat(segment.path)
    this.assertPrivateFile(current)
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new JournalIntegrityError("journal path changed during access")
    }
    segment.identity = { dev: stat.dev, ino: stat.ino }
  }

  private async discoverSegments(): Promise<Segment[]> {
    const directory = dirname(this.path)
    const base = basename(this.path)
    // The directory is checked for service ownership when acquiring the lock and syncing.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const names = await readdir(directory)
    const prefix = `${base}.segment.`
    const segments: Segment[] = []
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const suffix = name.slice(prefix.length)
      const start = Number(suffix)
      if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(start))
        throw new JournalIntegrityError("invalid journal segment name")
      segments.push({ path: join(directory, name), start, size: 0 })
    }
    segments.sort((a, b) => a.start - b.start)
    if (names.includes(base)) segments.unshift({ path: this.path, start: 1, size: 0 })
    else if (segments.length) throw new JournalIntegrityError("journal base segment is missing")
    return segments
  }

  private async indexedSegments(): Promise<Segment[]> {
    const found = await this.discoverSegments()
    if (
      this.loaded &&
      (found.length !== this.segments.length ||
        found.some((item, index) => item.path !== this.segments[index]?.path))
    )
      throw new JournalIntegrityError(
        "journal segments changed or appeared outside the active writer"
      )
    const known = new Map(this.segments.map((segment) => [segment.path, segment]))
    // A rejected bounded read must not update the active authenticated index.
    return found.map((segment) => ({ ...(known.get(segment.path) ?? segment) }))
  }

  private async assertSegmentIndex(): Promise<void> {
    await this.assertLockIdentity()
    const segments = await this.indexedSegments()
    for (const segment of segments) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const file = await open(
        segment.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        await this.assertFileIdentity(file, segment)
        this.assertIndexedStat(await file.stat({ bigint: true }), segment)
      } finally {
        await file.close()
      }
    }
  }

  private async readAll(limits?: JournalReadLimits): Promise<JournalRecord<T>[]> {
    await this.assertLockIdentity()
    const result = await readJournalSegments({
      segments: await this.indexedSegments(),
      limits,
      maxSegmentBytes: MAX_JOURNAL_BYTES,
      validatePayload: this.validatePayload,
      statStamp: (stat) => this.statStamp(stat),
      assertFileIdentity: (file, segment) => this.assertFileIdentity(file, segment),
      assertIndexedStat: (stat, segment) => this.assertIndexedStat(stat, segment),
      discoverSegments: () => this.discoverSegments(),
      assertLockIdentity: () => this.assertLockIdentity(),
    })
    this.segments = result.segments
    this.rangeIndex = result.rangeIndex
    return result.records
  }

  private async writeRecord(record: JournalRecord<T>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const length = Buffer.byteLength(line)
    if (length > this.maxSegmentBytes)
      throw new JournalIntegrityError("journal record exceeds segment size cap")
    await this.assertSegmentIndex()
    let segment = this.segments.at(-1)
    let created = false
    if (!segment || segment.size + length > this.maxSegmentBytes) {
      segment = {
        path: segment ? `${this.path}.segment.${record.sequence}` : this.path,
        start: record.sequence,
        size: 0,
      }
      created = true
    }
    // A segment is never overwritten, renamed, or adopted after failed creation.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const file = await open(
      segment.path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (created ? constants.O_CREAT | constants.O_EXCL : 0),
      0o600
    )
    try {
      await this.assertFileIdentity(file, segment)
      const before = await file.stat()
      if (before.size !== segment.size || before.size + length > this.maxSegmentBytes)
        throw new JournalIntegrityError("journal segment changed before append")
      if (!created) this.assertIndexedStat(await file.stat({ bigint: true }), segment)
      await file.writeFile(line, "utf8")
      await file.sync()
      await this.assertFileIdentity(file, segment)
      await this.assertLockIdentity()
      if (created) this.segments.push(segment)
      this.rangeIndex.push({
        offset: before.size,
        length,
        hash: record.hash,
        segment: this.segments.length - 1,
      })
      segment.size = before.size + length
      segment.indexedStat = this.statStamp(await file.stat({ bigint: true }))
    } finally {
      await file.close()
    }
    if (created) await this.syncDirectory()
    await this.assertSegmentIndex()
  }
}
