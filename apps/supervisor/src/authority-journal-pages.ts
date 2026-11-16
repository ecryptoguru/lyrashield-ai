import {
  IndependentAuthorityError,
  type IndependentAuthorityJournal,
  type JournalPort,
  MAX_SUPERVISOR_JOURNAL_PAGE_BYTES,
  bindSupervisorJournalSnapshot,
  canonicalJson,
  type AuthorityHead,
  type SupervisorJournalCursor,
  type SupervisorJournalPage,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
import { same, conflict } from "./authority-bindings"
import type { OriginalRecord, WrappedRecord } from "./authority-journal-options"

export function boundedJournalPage(
  cursor: SupervisorJournalCursor,
  snapshotHead: AuthorityHead | null,
  records: WrappedRecord[],
  hasMore: boolean,
  headSequence: number
): SupervisorJournalPage<SupervisorJournalEvent> {
  const snapshotCursor = bindSupervisorJournalSnapshot(cursor, snapshotHead)
  const page: SupervisorJournalPage<SupervisorJournalEvent> = {
    records: [],
    snapshotHead,
    nextCursor: snapshotCursor,
    hasMore,
  }
  for (const record of records) {
    const next = {
      records: [...page.records, record],
      snapshotHead,
      nextCursor: {
        ...snapshotCursor,
        afterSequence: record.sequence,
        afterHash: record.payload.payload.hash,
      },
      hasMore: record.sequence < headSequence,
    }
    if (Buffer.byteLength(canonicalJson(next)) > MAX_SUPERVISOR_JOURNAL_PAGE_BYTES) {
      if (!page.records.length)
        throw new IndependentAuthorityError("READ_LIMIT", "page cannot make bounded progress")
      break
    }
    Object.assign(page, next)
  }
  return page
}

export function fallbackJournalPage(
  cursor: SupervisorJournalCursor,
  snapshotHead: AuthorityHead | null,
  history: WrappedRecord[]
): SupervisorJournalPage<SupervisorJournalEvent> {
  const previous = cursor.afterSequence ? history[cursor.afterSequence - 1]?.payload.payload : null
  if (
    cursor.afterSequence > history.length ||
    cursor.afterHash !== (previous?.hash ?? "0".repeat(64))
  ) {
    throw new IndependentAuthorityError("CURSOR_CONFLICT", "cursor predecessor does not match")
  }
  const snapshotCursor = bindSupervisorJournalSnapshot(cursor, snapshotHead)
  const page: SupervisorJournalPage<SupervisorJournalEvent> = {
    records: [],
    snapshotHead,
    nextCursor: snapshotCursor,
    hasMore: cursor.afterSequence < history.length,
  }
  for (const record of history.slice(cursor.afterSequence, cursor.afterSequence + cursor.limit)) {
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
}

/** Caller keeps the serialized authority gate around both reads and the final authorization. */
export async function readBoundedJournalPage(
  original: JournalPort<SupervisorJournalEvent>,
  independent: IndependentAuthorityJournal<OriginalRecord>,
  cursor: SupervisorJournalCursor,
  expectedHead: OriginalRecord | null
): Promise<SupervisorJournalPage<SupervisorJournalEvent>> {
  const originals = await original.readRange!(cursor.afterSequence, {
    maxBytes: 1024 * 1024,
    maxRecords: cursor.limit,
  })
  if (originals.previousHash !== cursor.afterHash) {
    throw new IndependentAuthorityError("CURSOR_CONFLICT", "cursor predecessor does not match")
  }
  if (!same(originals.head, expectedHead)) {
    conflict("original range head changed outside the supervisor")
  }
  const confirmed = await independent.loadConfirmedRange(cursor.afterSequence, {
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
  const page = boundedJournalPage(
    cursor,
    independent.confirmedHead(),
    confirmed.records,
    originals.hasMore,
    originals.head?.sequence ?? 0
  )
  if (
    !same(
      originals,
      await original.readRange!(cursor.afterSequence, {
        maxBytes: 1024 * 1024,
        maxRecords: cursor.limit,
      })
    )
  )
    conflict("original range changed during readback")
  return page
}
