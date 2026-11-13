import { constants, type BigIntStats, type Stats } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import {
  JournalIntegrityError,
  JournalReadLimitError,
  validateSecret,
  verifyJournalRecord,
  type JournalRecord,
} from "./journal-record"

export interface JournalTailPosition {
  segmentStartSequence: number
  byteOffsetAfterLastSealedRecord: number
}
export interface JournalTailOptions {
  position: JournalTailPosition
  afterSequence: number
  afterHash: string
  expectedSequence: number
  expectedHash: string
  maxRecords: number
  maxBytes: number
}
export interface VerifiedJournalTail<T> {
  records: JournalRecord<T>[]
  rawRecords: Uint8Array[]
  endPosition: JournalTailPosition
  hasUnconfirmedSuffix: boolean
  bytesRead: number
}
interface OpenSegment {
  path: string
  start: number
  file: FileHandle
  stamp: string
  size: number
  cache?: Buffer
  cacheStart?: number
}
function stamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}
function privateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new JournalIntegrityError("journal tail file ownership or permissions are invalid")
}
function validate(input: JournalTailOptions): void {
  const {
    position,
    afterSequence,
    afterHash,
    expectedSequence,
    expectedHash,
    maxRecords,
    maxBytes,
  } = input
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 1 ||
    !Number.isSafeInteger(expectedSequence) ||
    expectedSequence < afterSequence ||
    !Number.isSafeInteger(position.segmentStartSequence) ||
    position.segmentStartSequence < 1 ||
    position.segmentStartSequence > afterSequence ||
    !Number.isSafeInteger(position.byteOffsetAfterLastSealedRecord) ||
    position.byteOffsetAfterLastSealedRecord < 1 ||
    !/^[a-f0-9]{64}$/.test(afterHash) ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 32 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1024 * 1024 ||
    expectedSequence - afterSequence > maxRecords
  )
    throw new JournalReadLimitError("invalid or exceeded bounded journal tail limit")
}
function segmentPath(base: string, start: number): string {
  return start === 1 ? base : `${base}.segment.${start}`
}
async function openSegment(path: string, start: number): Promise<OpenSegment> {
  let file: FileHandle
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new JournalIntegrityError("journal tail segment is unavailable")
    throw error
  }
  try {
    const stat = await file.stat()
    privateFile(stat)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const current = await lstat(path)
    privateFile(current)
    if (stat.dev !== current.dev || stat.ino !== current.ino || stat.size > 64 * 1024 * 1024)
      throw new JournalIntegrityError("journal tail segment identity or size differs")
    const snapshot = await file.stat({ bigint: true })
    if (
      snapshot.size !== BigInt(stat.size) ||
      snapshot.dev !== BigInt(stat.dev) ||
      snapshot.ino !== BigInt(stat.ino)
    )
      throw new JournalIntegrityError("journal tail segment changed during open")
    return { path, start, file, stamp: stamp(snapshot), size: stat.size }
  } catch (error) {
    await file.close()
    throw error
  }
}
async function recheckSegment(segment: OpenSegment): Promise<void> {
  const stat = await segment.file.stat()
  privateFile(stat)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const current = await lstat(segment.path)
  privateFile(current)
  if (
    stat.dev !== current.dev ||
    stat.ino !== current.ino ||
    stamp(await segment.file.stat({ bigint: true })) !== segment.stamp
  )
    throw new JournalIntegrityError("journal tail segment changed during read")
}
async function assertDirectory(directory: FileHandle, base: string): Promise<void> {
  const stat = await directory.stat()
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const current = await lstat(dirname(base))
  if (
    !stat.isDirectory() ||
    !current.isDirectory() ||
    stat.dev !== current.dev ||
    stat.ino !== current.ino ||
    (stat.mode & 0o022) !== 0 ||
    (current.mode & 0o022) !== 0 ||
    (process.getuid && (stat.uid !== process.getuid() || current.uid !== process.getuid()))
  )
    throw new JournalIntegrityError("journal tail directory is not owned by the service")
}
async function readAnchor<T>(
  segment: OpenSegment,
  offset: number,
  budget: number,
  secret: string,
  validatePayload: (value: unknown) => T,
  sequence: number,
  expectedHash: string
): Promise<number> {
  const chunks: Buffer[] = []
  let position = offset
  let consumed = 0
  let first = true
  while (position > 0) {
    if (consumed >= budget)
      throw new JournalReadLimitError("journal tail anchor exceeds byte limit")
    const length = Math.min(4096, position, budget - consumed)
    const start = position - length
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await segment.file.read(buffer, filled, length - filled, start + filled)
      if (!bytesRead) throw new JournalIntegrityError("journal tail anchor was truncated")
      filled += bytesRead
    }
    consumed += length
    if (first && buffer.at(-1) !== 10)
      throw new JournalIntegrityError("journal tail anchor is incomplete")
    const newline = buffer.lastIndexOf(10, first ? length - 2 : length - 1)
    first = false
    if (newline >= 0) {
      chunks.unshift(buffer.subarray(newline + 1))
      position = 0
      break
    }
    chunks.unshift(buffer)
    position = start
  }
  if (position > 0) throw new JournalReadLimitError("journal tail anchor exceeds byte limit")
  const bytes = Buffer.concat(chunks)
  const text = bytes.toString("utf8")
  if (!Buffer.from(text).equals(bytes))
    throw new JournalIntegrityError("journal tail anchor has invalid UTF-8")
  const record = verifyJournalRecord(JSON.parse(text), secret, validatePayload)
  if (record.sequence !== sequence || record.hash !== expectedHash)
    throw new JournalIntegrityError("journal tail anchor differs from the sealed head")
  return consumed
}
async function nextLine(
  segment: OpenSegment,
  offset: number,
  budget: number
): Promise<{ bytes: Buffer; nextOffset: number; readBytes: number }> {
  const chunks: Buffer[] = []
  let position = offset,
    total = 0
  while (position < segment.size) {
    let buffer: Buffer
    if (
      segment.cache &&
      segment.cacheStart !== undefined &&
      position >= segment.cacheStart &&
      position < segment.cacheStart + segment.cache.length
    ) {
      buffer = segment.cache.subarray(position - segment.cacheStart)
    } else {
      if (total >= budget) throw new JournalReadLimitError("journal tail byte limit exceeded")
      const next = Buffer.alloc(Math.min(64 * 1024, segment.size - position, budget - total))
      const { bytesRead } = await segment.file.read(next, 0, next.length, position)
      if (!bytesRead) throw new JournalIntegrityError("journal tail segment was truncated")
      total += bytesRead
      buffer = next.subarray(0, bytesRead)
      segment.cache = buffer
      segment.cacheStart = position
    }
    const newline = buffer.indexOf(10)
    if (newline >= 0) {
      chunks.push(buffer.subarray(0, newline + 1))
      return { bytes: Buffer.concat(chunks), nextOffset: position + newline + 1, readBytes: total }
    }
    chunks.push(buffer)
    position += buffer.length
  }
  throw new JournalIntegrityError("journal tail contains an incomplete record")
}

/** The caller must independently authenticate the seal anchor and current heads before and after this read. */
export async function readSignedJournalTail<T>(
  base: string,
  secret: string,
  validatePayload: (value: unknown) => T,
  input: JournalTailOptions
): Promise<VerifiedJournalTail<T>> {
  validateSecret(secret)
  validate(input)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const directory = await open(
    dirname(base),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  const segments: OpenSegment[] = []
  try {
    await assertDirectory(directory, base)
    let segment = await openSegment(
      segmentPath(base, input.position.segmentStartSequence),
      input.position.segmentStartSequence
    )
    segments.push(segment)
    let offset = input.position.byteOffsetAfterLastSealedRecord
    if (offset > segment.size)
      throw new JournalIntegrityError("sealed journal tail offset is unavailable")
    let sequence = input.afterSequence,
      previousHash = input.afterHash
    let bytesRead = await readAnchor(
      segment,
      offset,
      input.maxBytes,
      secret,
      validatePayload,
      sequence,
      previousHash
    )
    const records: JournalRecord<T>[] = [],
      rawRecords: Uint8Array[] = []
    while (sequence < input.expectedSequence) {
      if (offset === segment.size) {
        segment = await openSegment(segmentPath(base, sequence + 1), sequence + 1)
        segments.push(segment)
        offset = 0
      }
      const line = await nextLine(segment, offset, input.maxBytes - bytesRead)
      bytesRead += line.readBytes
      const text = line.bytes.toString("utf8")
      if (!Buffer.from(text).equals(line.bytes))
        throw new JournalIntegrityError("journal tail record has invalid UTF-8")
      const record = verifyJournalRecord(JSON.parse(text), secret, validatePayload)
      if (record.sequence !== sequence + 1 || record.previousHash !== previousHash)
        throw new JournalIntegrityError("journal tail sequence or predecessor chain differs")
      records.push(record)
      rawRecords.push(line.bytes)
      sequence = record.sequence
      previousHash = record.hash
      offset = line.nextOffset
    }
    if (previousHash !== input.expectedHash)
      throw new JournalIntegrityError("journal tail head hash differs")
    let hasUnconfirmedSuffix = offset < segment.size
    if (!hasUnconfirmedSuffix) {
      try {
        const next = await openSegment(segmentPath(base, sequence + 1), sequence + 1)
        segments.push(next)
        hasUnconfirmedSuffix = true
      } catch (error) {
        if (
          !(error instanceof JournalIntegrityError) ||
          error.message !== "journal tail segment is unavailable"
        )
          throw error
      }
    }
    for (const item of segments) await recheckSegment(item)
    await assertDirectory(directory, base)
    return {
      records,
      rawRecords,
      endPosition: { segmentStartSequence: segment.start, byteOffsetAfterLastSealedRecord: offset },
      hasUnconfirmedSuffix,
      bytesRead,
    }
  } finally {
    await Promise.all(segments.map((segment) => segment.file.close()))
    await directory.close()
  }
}
