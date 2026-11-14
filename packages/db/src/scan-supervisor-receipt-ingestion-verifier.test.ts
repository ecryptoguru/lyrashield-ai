import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  authorityEventSchema,
  canonicalJson,
  SignedJournal,
  type AuthorityHead,
} from "@lyrashield/runtime-control"
import { z } from "zod"
import {
  checkReceiptKeys,
  verifyReceiptPage,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import { sha256Hex } from "./scan-supervisor-receipt-verifier"

const roots: string[] = []
const originalSecret = "o".repeat(48),
  wrapperSecret = "w".repeat(48)
const authority: SupervisorReceiptAuthority = {
  streamId: "stream-one",
  authorityEpochId: "epoch-one",
  supervisorInstanceId: "supervisor-one",
  connectionString: "postgresql://fixture:fixture@localhost:1/lyrashield_test",
  originalSigningSecret: originalSecret,
  originalKeyHash: sha256Hex(originalSecret),
  wrapperSigningSecret: wrapperSecret,
  wrapperKeyHash: sha256Hex(wrapperSecret),
  readJournal: async () => null,
}
const cursor = {
  epochId: authority.authorityEpochId,
  supervisorInstanceId: authority.supervisorInstanceId,
  afterSequence: 0,
  afterHash: "0".repeat(64),
  limit: 100,
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "receipt-consumer-test-"))
  roots.push(root)
  const original = new SignedJournal(
    join(root, "original"),
    originalSecret,
    (value) => value as Record<string, unknown>
  )
  const wrapped = new SignedJournal(
    join(root, "wrapped"),
    wrapperSecret,
    authorityEventSchema(z.unknown()).parse
  )
  const payload = {
    epochId: authority.authorityEpochId,
    operationId: "operation-one",
    scanId: "scan-one",
    workspaceId: "workspace-one",
    attemptId: "attempt-one",
  }
  const records = []
  try {
    for (const type of ["command_intent", "command_terminal", "command_recovery_hold"]) {
      const signed = await original.append({
        type,
        supervisorInstanceId: authority.supervisorInstanceId,
        observedAt: "2026-11-13T10:00:00.000Z",
        commandId: "command-one",
        status: "STARTED",
      })
      records.push(
        await wrapped.append({ ...payload, eventId: `supervisor:${signed.hash}`, payload: signed })
      )
    }
  } finally {
    await original.close()
    await wrapped.close()
  }
  const record = records.at(-1)!
  const unsigned = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId: authority.supervisorInstanceId,
    ...payload,
    eventId: record.payload.eventId,
    sequence: record.sequence,
    previousHash: record.previousHash,
    recordHash: record.hash,
  }
  const head: AuthorityHead = {
    ...unsigned,
    signature: createHmac("sha256", wrapperSecret).update(canonicalJson(unsigned)).digest("hex"),
  }
  const nextCursor = {
    ...cursor,
    afterSequence: record.sequence,
    afterHash: (record.payload.payload as { hash: string }).hash,
    snapshotSequence: head.sequence,
    snapshotHash: head.recordHash,
  }
  return { records, head, page: { records, snapshotHead: head, nextCursor, hasMore: false } }
}

describe("authenticated broker journal pages", () => {
  it("authenticates both native signed streams, final head and its pinned keys", async () => {
    const f = await fixture()
    expect(() => checkReceiptKeys(authority)).not.toThrow()
    const verified = verifyReceiptPage(f.page, authority, cursor, "0".repeat(64), undefined)
    expect(verified.records).toEqual(f.records)
    expect(verified.head).toEqual(f.head)
    expect(
      verifyReceiptPage(
        { ...f.page, records: [] },
        authority,
        verified.nextCursor,
        verified.wrapperHash,
        verified.head
      ).records
    ).toEqual([])
  })
  it("keeps an earlier positive page incomplete until its later recovery hold", async () => {
    const f = await fixture()
    const firstRecord = f.records[1]!
    const first = {
      ...f.page,
      records: f.records.slice(0, 2),
      hasMore: true,
      nextCursor: {
        ...f.page.nextCursor,
        afterSequence: 2,
        afterHash: (firstRecord.payload.payload as { hash: string }).hash,
      },
    }
    const partial = verifyReceiptPage(first, authority, cursor, "0".repeat(64), undefined)
    expect(partial.hasMore).toBe(true)
    const final = verifyReceiptPage(
      { ...f.page, records: f.records.slice(2) },
      authority,
      partial.nextCursor,
      partial.wrapperHash,
      partial.head
    )
    expect(final.hasMore).toBe(false)
    expect((final.records[0]!.payload.payload.payload as { type: string }).type).toBe(
      "command_recovery_hold"
    )
  })
  it.each(["payload", "head", "cursor", "premature", "missing"])(
    "rejects %s tampering",
    async (kind) => {
      const f = await fixture()
      const page = structuredClone(f.page)
      if (kind === "payload")
        (page.records[1]!.payload.payload as { payload: { status: string } }).payload.status =
          "STOPPED"
      if (kind === "head") page.snapshotHead.signature = "a".repeat(64)
      if (kind === "cursor") page.nextCursor.afterHash = "b".repeat(64)
      if (kind === "premature") {
        page.records.pop()
        page.nextCursor.afterSequence = 2
      }
      if (kind === "missing") page.records.splice(1, 1)
      expect(() => verifyReceiptPage(page, authority, cursor, "0".repeat(64), undefined)).toThrow()
    }
  )
  it("rejects a foreign installed key or supervisor identity", async () => {
    const f = await fixture()
    expect(() => checkReceiptKeys({ ...authority, wrapperKeyHash: "a".repeat(64) })).toThrow()
    expect(() =>
      verifyReceiptPage(
        f.page,
        { ...authority, supervisorInstanceId: "supervisor-other" },
        cursor,
        "0".repeat(64),
        undefined
      )
    ).toThrow()
  })
  it("rejects changed snapshot continuation before confirming staged evidence", async () => {
    const f = await fixture()
    expect(() =>
      verifyReceiptPage(f.page, authority, cursor, "0".repeat(64), {
        ...f.head,
        recordHash: "b".repeat(64),
      })
    ).toThrow()
  })
})
