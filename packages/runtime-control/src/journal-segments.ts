import { constants, type BigIntStats } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import {
  JournalIntegrityError,
  JournalReadLimitError,
  validatedEnvelope,
  type JournalRecord,
} from "./journal-record"
import type { JournalReadLimits } from "./journal"

export interface JournalSegment {
  path: string
  start: number
  identity?: { dev: number; ino: number }
  indexedStat?: string
  size: number
}

export type SegmentRangeIndex = { offset: number; length: number; hash: string; segment: number }[]

interface SegmentReaderOptions<T> {
  segments: JournalSegment[]
  limits?: JournalReadLimits
  maxSegmentBytes: number
  validatePayload: (value: unknown) => T
  statStamp: (stat: BigIntStats) => string
  assertFileIdentity: (file: FileHandle, segment: JournalSegment) => Promise<void>
  assertIndexedStat: (stat: BigIntStats, segment: JournalSegment) => void
  discoverSegments: () => Promise<JournalSegment[]>
  assertLockIdentity: () => Promise<void>
}

/** Read and index complete segments without publishing partially read metadata. */
export async function readJournalSegments<T>({
  segments,
  limits,
  maxSegmentBytes,
  validatePayload,
  statStamp,
  assertFileIdentity,
  assertIndexedStat,
  discoverSegments,
  assertLockIdentity,
}: SegmentReaderOptions<T>): Promise<{
  segments: JournalSegment[]
  rangeIndex: SegmentRangeIndex
  records: JournalRecord<T>[]
}> {
  let totalSize = 0
  const stamps = new Map<string, string>()
  // Check all sizes before reading any bytes; bounded callers retain their original contract.
  for (const segment of segments) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const file = await open(
      segment.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      await assertFileIdentity(file, segment)
      const stat = await file.stat({ bigint: true })
      if (stat.size > BigInt(maxSegmentBytes))
        throw new JournalIntegrityError("journal segment exceeds size cap")
      totalSize += Number(stat.size)
      if (limits && totalSize > limits.maxBytes)
        throw new JournalReadLimitError("journal exceeds bounded read size")
      stamps.set(segment.path, statStamp(stat))
    } finally {
      await file.close()
    }
  }
  const records: JournalRecord<T>[] = []
  const rangeIndex: SegmentRangeIndex = []
  for (const [segmentIndex, segment] of segments.entries()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const file = await open(
      segment.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    let raw: string
    try {
      await assertFileIdentity(file, segment)
      const before = await file.stat({ bigint: true })
      if (statStamp(before) !== stamps.get(segment.path))
        throw new JournalIntegrityError("journal changed before reading")
      if (before.size > BigInt(maxSegmentBytes))
        throw new JournalIntegrityError("journal segment exceeds size cap")
      const size = Number(before.size)
      const buffer = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const read = await file.read(buffer, offset, size - offset, offset)
        if (!read.bytesRead) throw new JournalIntegrityError("journal segment was truncated")
        offset += read.bytesRead
      }
      const after = await file.stat({ bigint: true })
      if (statStamp(before) !== statStamp(after))
        throw new JournalIntegrityError("journal changed while reading")
      await assertFileIdentity(file, segment)
      segment.indexedStat = statStamp(after)
      segment.size = size
      raw = buffer.toString("utf8")
      if (!Buffer.from(raw, "utf8").equals(buffer))
        throw new JournalIntegrityError("journal segment has invalid UTF-8")
    } finally {
      await file.close()
    }
    if (segment.start !== records.length + 1)
      throw new JournalIntegrityError("journal segment sequence is invalid")
    if (raw && !raw.endsWith("\n"))
      throw new JournalIntegrityError("journal contains an incomplete record")
    if (!raw && segmentIndex !== segments.length - 1)
      throw new JournalIntegrityError("journal contains an empty intermediate segment")
    const firstRecordIndex = records.length
    let position = 0
    for (const line of raw.split("\n")) {
      const length = Buffer.byteLength(line) + 1
      if (!line) {
        position += length
        continue
      }
      if (limits && records.length >= limits.maxRecords)
        throw new JournalReadLimitError("journal exceeds bounded record count")
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new JournalIntegrityError("journal contains an incomplete or invalid record")
      }
      const record = validatedEnvelope(parsed, validatePayload)
      records.push(record)
      rangeIndex.push({ offset: position, length, hash: record.hash, segment: segmentIndex })
      position += length
    }
    if (records.length === firstRecordIndex && segmentIndex !== segments.length - 1)
      throw new JournalIntegrityError("journal contains an empty intermediate segment")
  }
  // Confirm that a segment did not appear during enumeration and reads.
  const found = await discoverSegments()
  if (
    found.length !== segments.length ||
    found.some((item, index) => item.path !== segments[index]?.path)
  )
    throw new JournalIntegrityError("journal segments changed while reading")
  for (const segment of segments) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const file = await open(
      segment.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      await assertFileIdentity(file, segment)
      assertIndexedStat(await file.stat({ bigint: true }), segment)
    } finally {
      await file.close()
    }
  }
  await assertLockIdentity()
  return { segments, rangeIndex, records }
}
