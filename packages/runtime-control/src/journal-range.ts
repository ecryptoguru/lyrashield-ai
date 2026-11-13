import type { FileHandle } from "node:fs/promises"
import {
  JournalIntegrityError,
  JournalReadLimitError,
  verifyJournalRecord,
  type JournalRecord,
} from "./journal-record"
import type { JournalRange, JournalReadLimits } from "./journal"

export type JournalRangeIndex = { offset: number; length: number; hash: string }[]

/** The owner authenticates file identity and timestamps around this bounded read. */
export async function readIndexedJournalRange<T>(
  fileForIndex: (index: number) => Promise<FileHandle>,
  positions: JournalRangeIndex,
  afterSequence: number,
  bounds: JournalReadLimits,
  secret: string,
  validatePayload: (value: unknown) => T,
  capture?: (sequence: number, bytes: Uint8Array) => void
): Promise<JournalRange<T>> {
  let bytes = 0
  const read = async (index: number) => {
    const position = positions[index]!
    if (bytes + position.length > bounds.maxBytes)
      throw new JournalReadLimitError("journal range exceeds byte limit")
    bytes += position.length
    const buffer = Buffer.alloc(position.length)
    const file = await fileForIndex(index)
    let offset = 0
    while (offset < buffer.length) {
      const result = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        position.offset + offset
      )
      if (!result.bytesRead) throw new JournalIntegrityError("journal range was truncated")
      offset += result.bytesRead
    }
    if (buffer.at(-1) !== 10) throw new JournalIntegrityError("journal range is incomplete")
    const record = verifyJournalRecord(JSON.parse(buffer.toString("utf8")), secret, validatePayload)
    if (
      record.sequence !== index + 1 ||
      record.hash !== position.hash ||
      record.previousHash !== (positions[index - 1]?.hash ?? "0".repeat(64))
    ) {
      throw new JournalIntegrityError("journal range differs from authenticated chain")
    }
    capture?.(record.sequence, buffer)
    return record
  }
  const head = positions.length ? await read(positions.length - 1) : null
  const records: JournalRecord<T>[] = []
  for (
    let index = afterSequence;
    index < Math.min(positions.length, afterSequence + bounds.maxRecords);
    index++
  ) {
    if (index === positions.length - 1) {
      records.push(head!)
      continue
    }
    if (bytes + positions[index]!.length > bounds.maxBytes) {
      if (!records.length)
        throw new JournalReadLimitError("journal range cannot make bounded progress")
      break
    }
    records.push(await read(index))
  }
  return {
    records,
    head,
    previousHash: positions[afterSequence - 1]?.hash ?? "0".repeat(64),
    hasMore: afterSequence + records.length < positions.length,
  }
}
