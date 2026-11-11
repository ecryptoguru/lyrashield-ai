import { createHmac, timingSafeEqual } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, unlink, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { canonicalJson, sha256Hex } from "./canonical-json"

const JOURNAL_VERSION = 1
const MIN_SECRET_BYTES = 32
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024

export interface JournalPort<T> {
  append(payload: T): Promise<JournalRecord<T>>
  load(): Promise<JournalRecord<T>[]>
  /** Explicitly fsync an existing exact record without appending or re-signing it. */
  confirmRecord?(record: JournalRecord<T>): Promise<JournalRecord<T>>
  loadBounded?(limits: JournalReadLimits): Promise<JournalRecord<T>[]>
}

export interface JournalReadLimits {
  maxBytes: number
  maxRecords: number
}

export class JournalReadLimitError extends Error {
  readonly code = "JOURNAL_READ_LIMIT"
}

export interface JournalRecord<T> {
  version: 1
  sequence: number
  previousHash: string
  hash: string
  signature: string
  payload: T
}

export class JournalIntegrityError extends Error {
  readonly code = "JOURNAL_INTEGRITY"

  constructor(message: string) {
    super(message)
    this.name = "JournalIntegrityError"
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function signRecord(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex")
}

function recordHash(record: Omit<JournalRecord<unknown>, "hash" | "signature">): string {
  return sha256Hex(
    canonicalJson({
      version: record.version,
      sequence: record.sequence,
      previousHash: record.previousHash,
      payload: record.payload,
    })
  )
}

function validateSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`journal signing secret must be at least ${MIN_SECRET_BYTES} bytes`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function recordEnvelope(
  value: unknown
): Omit<JournalRecord<unknown>, "payload"> & { payload: unknown } {
  if (!isRecord(value)) throw new JournalIntegrityError("journal record is not an object")
  const { version, sequence, previousHash, hash, signature, payload } = value
  if (
    version !== JOURNAL_VERSION ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 1 ||
    typeof previousHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(previousHash) ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    throw new JournalIntegrityError("journal envelope is malformed")
  }
  return {
    version: JOURNAL_VERSION,
    sequence: sequence as number,
    previousHash,
    hash,
    signature,
    payload,
  }
}

/** Verify one unchanged signed envelope; callers must separately authenticate its chain anchor. */
export function verifyJournalRecord<T>(
  value: unknown,
  secret: string,
  validatePayload: (value: unknown) => T
): JournalRecord<T> {
  validateSecret(secret)
  const envelope = recordEnvelope(value)
  const record = { ...envelope, payload: validatePayload(envelope.payload) }
  const { hash, signature, ...unsigned } = record
  const expectedHash = recordHash(unsigned)
  const expectedSignature = signRecord(secret, canonicalJson({ ...unsigned, hash: expectedHash }))
  if (!secureEqual(hash, expectedHash) || !secureEqual(signature, expectedSignature)) {
    throw new JournalIntegrityError("journal signature or record hash is invalid")
  }
  return record
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
  private fileIdentity: { dev: number; ino: number } | null = null

  constructor(
    private readonly path: string,
    private readonly secret: string,
    private readonly validatePayload: (value: unknown) => T
  ) {
    validateSecret(secret)
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
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const file = await open(
          this.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        try {
          await this.assertFileIdentity(file)
          await file.sync()
          await this.assertFileIdentity(file)
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

  private async assertFileIdentity(file: FileHandle): Promise<void> {
    const stat = await file.stat()
    this.assertPrivateFile(stat)
    if (
      this.fileIdentity &&
      (stat.dev !== this.fileIdentity.dev || stat.ino !== this.fileIdentity.ino)
    ) {
      throw new JournalIntegrityError("journal file was replaced")
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const current = await lstat(this.path)
    this.assertPrivateFile(current)
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new JournalIntegrityError("journal path changed during access")
    }
    this.fileIdentity = { dev: stat.dev, ino: stat.ino }
  }

  private async readAll(limits?: JournalReadLimits): Promise<JournalRecord<T>[]> {
    await this.assertLockIdentity()
    let file: FileHandle
    try {
      // No symlinks or blocking special files are accepted as journals.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.fileIdentity) return []
      throw error
    }
    let raw: string
    const maxBytes = limits?.maxBytes ?? MAX_JOURNAL_BYTES
    try {
      await this.assertFileIdentity(file)
      const before = await file.stat()
      if (before.size > maxBytes) {
        if (limits) throw new JournalReadLimitError("journal exceeds bounded read size")
        throw new JournalIntegrityError("journal exceeds size cap")
      }
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - offset))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        if (offset > maxBytes) {
          if (limits) throw new JournalReadLimitError("journal exceeds bounded read size")
          throw new JournalIntegrityError("journal exceeds size cap")
        }
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new JournalIntegrityError("journal changed while reading")
      }
      await this.assertFileIdentity(file)
      raw = Buffer.concat(chunks, offset).toString("utf8")
    } finally {
      await file.close()
    }
    if (raw && !raw.endsWith("\n"))
      throw new JournalIntegrityError("journal contains an incomplete record")
    if (!raw.trim()) return []
    const records: JournalRecord<T>[] = []
    for (const line of raw.split("\n")) {
      if (!line) continue
      if (limits && records.length >= limits.maxRecords) {
        throw new JournalReadLimitError("journal exceeds bounded record count")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new JournalIntegrityError("journal contains an incomplete or invalid record")
      }
      const envelope = recordEnvelope(parsed)
      records.push({ ...envelope, payload: this.validatePayload(envelope.payload) })
    }
    return records
  }

  private async writeRecord(record: JournalRecord<T>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line) > MAX_JOURNAL_BYTES)
      throw new JournalIntegrityError("journal record exceeds size cap")
    await this.assertLockIdentity()
    let created = false
    let file: FileHandle
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      file = await open(
        this.path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      )
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !this.fileIdentity) throw error
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      file = await open(
        this.path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
    }
    try {
      await this.assertFileIdentity(file)
      const before = await file.stat()
      if (before.size + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) {
        throw new JournalIntegrityError("journal exceeds size cap")
      }
      await file.writeFile(line, "utf8")
      await file.sync()
      await this.assertFileIdentity(file)
      await this.assertLockIdentity()
    } finally {
      await file.close()
    }
    if (created) await this.syncDirectory()
  }
}
