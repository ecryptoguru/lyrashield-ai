import { createHash, createHmac, randomUUID } from "node:crypto"
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { assertDisposableDatabasePair } from "../../../.github/scripts/vitest-database-env.mjs"
import { canonicalJson } from "./canonical-json"
import {
  IndependentAuthorityJournal,
  authorityEventSchema,
  type AuthorityHead,
  type ConditionalObjectStore,
  type StoredObject,
} from "./independent-journal"
import { SignedJournal, type JournalRecord } from "./journal"
import { PostgresAuthorityMirror } from "./postgres-mirror"
import { JournalSealPublisher, JournalSealPendingError } from "./journal-seal-publisher"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import { withVerifiedJournalContinuation } from "./journal-continuation"
import { auditJournalSealArchives } from "./journal-seal-archive"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"
import { R2ConditionalObjectStore } from "./r2-store"

const enabled = process.env.AUTHORITY_MIRROR_POSTGRES_TEST === "1"
let owner: pg.Pool
let runtime: pg.Pool
let worker: pg.Pool

beforeAll(() => {
  if (!enabled) return
  assertDisposableDatabasePair(process.env)
  owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 })
  runtime = new pg.Pool({
    connectionString: process.env.RLS_RUNTIME_DATABASE_URL,
    connectionTimeoutMillis: 3000,
  })
  // Same fixture and credentials, but a role deliberately denied authority schema access.
  const workerUrl = new URL(process.env.RLS_RUNTIME_DATABASE_URL!)
  workerUrl.username = "authority_worker"
  worker = new pg.Pool({ connectionString: workerUrl.toString(), connectionTimeoutMillis: 3000 })
})
afterAll(async () => {
  if (enabled) await Promise.all([owner.end(), runtime.end(), worker.end()])
})

async function fixture(active = true) {
  const epoch = `epoch-${randomUUID()}`
  const supervisor = `supervisor-${randomUUID()}`
  await owner.query(
    "INSERT INTO lyrashield_authority.stream (epoch_id,supervisor_id,active) VALUES ($1,$2,$3)",
    [epoch, supervisor, active]
  )
  return { epoch, supervisor, mirror: new PostgresAuthorityMirror(runtime, epoch, supervisor) }
}

function append(
  epoch: string,
  supervisor: string,
  previous: AuthorityHead | null = null,
  eventId = randomUUID()
) {
  const record: JournalRecord<unknown> = {
    version: 1,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.recordHash ?? "0".repeat(64),
    hash: createHash("sha256").update(eventId).digest("hex"),
    signature: "d".repeat(64),
    payload: {
      epochId: epoch,
      operationId: "operation-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      eventId,
      payload: { action: "START" },
    },
  }
  const head: AuthorityHead = {
    schema: "lyrashield-independent-authority-head/1",
    supervisorInstanceId: supervisor,
    ...(record.payload as Omit<
      AuthorityHead,
      "schema" | "supervisorInstanceId" | "sequence" | "previousHash" | "recordHash" | "signature"
    >),
    sequence: record.sequence,
    previousHash: record.previousHash,
    recordHash: record.hash,
    signature: "e".repeat(64),
  }
  // The head deliberately excludes event payload; the signed journal authenticates these fixtures elsewhere.
  Reflect.deleteProperty(head, "payload")
  return { head, record }
}

function sealFor(
  head: AuthorityHead,
  previous: ReturnType<typeof sealFor> | null = null
): {
  schema: "lyrashield-journal-seal/1"
  epochId: string
  supervisorInstanceId: string
  revision: number
  firstSequence: number
  lastSequence: number
  previousSealHash: string
  originalPreviousHash: string
  originalLastHash: string
  wrapperPreviousHash: string
  wrapperLastHash: string
  originalSegmentSha256: string
  wrapperSegmentSha256: string
  originalBytes: number
  wrapperBytes: number
  recordCount: number
  independentHeadHash: string
  observedJournalAckHash: string
  sealHash: string
  signature: string
} {
  const body = {
    schema: "lyrashield-journal-seal/1" as const,
    epochId: head.epochId,
    supervisorInstanceId: head.supervisorInstanceId,
    revision: (previous?.revision ?? 0) + 1,
    firstSequence: (previous?.lastSequence ?? 0) + 1,
    lastSequence: head.sequence,
    previousSealHash: previous?.sealHash ?? "0".repeat(64),
    originalPreviousHash: previous?.originalLastHash ?? "0".repeat(64),
    originalLastHash: createHash("sha256").update(`original-${head.sequence}`).digest("hex"),
    wrapperPreviousHash: previous?.wrapperLastHash ?? "0".repeat(64),
    wrapperLastHash: head.recordHash,
    originalSegmentSha256: "a".repeat(64),
    wrapperSegmentSha256: "b".repeat(64),
    originalBytes: 100,
    wrapperBytes: 100,
    recordCount: head.sequence - (previous?.lastSequence ?? 0),
    independentHeadHash: createHash("sha256").update(canonicalJson(head)).digest("hex"),
    observedJournalAckHash: "c".repeat(64),
  }
  return {
    ...body,
    sealHash: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    signature: "d".repeat(64),
  }
}

describe.skipIf(!enabled)("restricted PostgreSQL authority mirror", () => {
  it("atomically stores append-only seals on the exact current journal and prior seal heads", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    expect(await mirror.readSealHeadBounded(16384)).toBeNull()
    const first = append(epoch, supervisor)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    const seal = sealFor(first.head)
    expect(await mirror.compareAndAppendSeal(null, seal, first.head)).toBe("written")
    expect(await mirror.readSealHeadBounded(16384)).toEqual(seal)
    expect(await mirror.readSealBounded(1, 16384)).toEqual(seal)
    expect(await mirror.readSealBounded(2, 16384)).toBeNull()
    expect(await mirror.compareAndAppendSeal(null, seal, first.head)).toBe("written")
    await expect(mirror.readSealHeadBounded(1)).rejects.toThrow(/limit/)
    const next = append(epoch, supervisor, first.head)
    expect(await mirror.compareAndAppend(first.head, next.head, next.record)).toBe("written")
    expect(await mirror.compareAndAppendSeal(null, seal, first.head)).toBe("conflict")
    const nextSeal = sealFor(next.head, seal)
    expect(await mirror.compareAndAppendSeal(seal, nextSeal, next.head)).toBe("written")
    expect(await mirror.readSealHeadBounded(16384)).toEqual(nextSeal)
    expect(await mirror.readSealBounded(1, 16384)).toEqual(seal)
    expect(await mirror.compareAndAppendSeal(null, seal, first.head)).toBe("conflict")
    const stored = await owner.query(
      "SELECT count(*) FROM lyrashield_authority.seal WHERE epoch_id=$1",
      [epoch]
    )
    expect(stored.rows[0].count).toBe("2")
    const third = append(epoch, supervisor, next.head)
    expect(await mirror.compareAndAppend(next.head, third.head, third.record)).toBe("written")
    await owner.query("DELETE FROM lyrashield_authority.seal WHERE epoch_id=$1 AND revision=2", [
      epoch,
    ])
    await expect(
      mirror.compareAndAppendSeal(nextSeal, sealFor(third.head, nextSeal), third.head)
    ).resolves.toBe("conflict")
    expect(await mirror.readSealHeadBounded(16384)).toEqual(nextSeal)
  })

  it("replays the exact seal after a real PostgreSQL commit acknowledgement is lost", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const first = append(epoch, supervisor)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    const seal = sealFor(first.head)
    let lost = false
    const lostReply = new PostgresAuthorityMirror(
      {
        query: (text, values) => runtime.query(text, values),
        connect: async () => {
          const connection = await runtime.connect()
          let sealing = false
          return {
            query: async (text, values) => {
              if (text.includes("lyrashield_authority.append_seal")) sealing = true
              const result = await connection.query(text, values)
              if (text === "COMMIT" && sealing && !lost) {
                lost = true
                throw new Error("seal commit reply lost")
              }
              return result
            },
            release: (destroy) => connection.release(destroy),
          }
        },
      },
      epoch,
      supervisor
    )
    await expect(lostReply.compareAndAppendSeal(null, seal, first.head)).rejects.toThrow(
      "seal commit reply lost"
    )
    expect(await mirror.readSealHeadBounded(16384)).toEqual(seal)
    expect(await mirror.compareAndAppendSeal(null, seal, first.head)).toBe("written")
    const count = await owner.query(
      "SELECT count(*) FROM lyrashield_authority.seal WHERE epoch_id=$1",
      [epoch]
    )
    expect(count.rows[0].count).toBe("1")
  })

  it("seals a contiguous historical prefix while fencing the exact current journal head", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const first = append(epoch, supervisor)
    const second = append(epoch, supervisor, first.head)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    expect(await mirror.compareAndAppend(first.head, second.head, second.record)).toBe("written")
    const initial = sealFor(first.head)
    const { sealHash, signature, ...body } = initial
    const prefixBody = {
      ...body,
      independentHeadHash: createHash("sha256").update(canonicalJson(second.head)).digest("hex"),
    }
    const prefix = {
      ...prefixBody,
      sealHash: createHash("sha256").update(canonicalJson(prefixBody)).digest("hex"),
      signature,
    }
    expect(prefix.sealHash).not.toBe(sealHash)
    expect(await mirror.compareAndAppendSeal(null, prefix, second.head)).toBe("written")
    expect(await mirror.readSealHeadBounded(16384)).toEqual(prefix)
    const following = sealFor(second.head, prefix)
    expect(await mirror.compareAndAppendSeal(prefix, following, second.head)).toBe("written")
  })

  it("retains v1 seal bytes and atomically appends a v2 seal with recovery positions", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const first = append(epoch, supervisor)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    const v1 = sealFor(first.head)
    expect(await mirror.compareAndAppendSeal(null, v1, first.head)).toBe("written")
    const second = append(epoch, supervisor, first.head)
    expect(await mirror.compareAndAppend(first.head, second.head, second.record)).toBe("written")
    const { sealHash: previousHash, signature, ...base } = sealFor(second.head, v1)
    const v2Body = {
      ...base,
      schema: "lyrashield-journal-seal/2" as const,
      originalSegmentStartSequence: 1,
      originalByteOffset: 400,
      wrapperSegmentStartSequence: 1,
      wrapperByteOffset: 500,
      recoverySnapshotSha256: "e".repeat(64),
      recoverySnapshotBytes: 1024,
    }
    const v2 = {
      ...v2Body,
      sealHash: createHash("sha256").update(canonicalJson(v2Body)).digest("hex"),
      signature,
    }
    expect(v2.sealHash).not.toBe(previousHash)
    expect(await mirror.compareAndAppendSeal(v1, v2, second.head)).toBe("written")
    expect(await mirror.readSealBounded(1, 16384)).toEqual(v1)
    expect(await mirror.readSealBounded(2, 16384)).toEqual(v2)
    expect(await mirror.readSealHeadBounded(16384)).toEqual(v2)
  })

  it("upgrades an existing v1 installation without changing retained seal bytes", async () => {
    const baseSql = await readFile("packages/runtime-control/sql/authority-seal.sql", "utf8")
    const start = baseSql.indexOf("CREATE FUNCTION lyrashield_authority.append_seal(")
    const end = baseSql.indexOf("REVOKE ALL ON FUNCTION lyrashield_authority.read_seal_head", start)
    if (start < 0 || end < 0) throw new Error("missing original seal function")
    const originalFunction = baseSql
      .slice(start, end)
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    const upgrade = await readFile("packages/runtime-control/sql/authority-seal-v2.sql", "utf8")
    try {
      await owner.query(originalFunction)
      const { epoch, supervisor, mirror } = await fixture()
      const first = append(epoch, supervisor)
      expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
      const v1 = sealFor(first.head)
      expect(await mirror.compareAndAppendSeal(null, v1, first.head)).toBe("written")
      const retained = await owner.query(
        "SELECT seal_bytes FROM lyrashield_authority.seal WHERE epoch_id=$1",
        [epoch]
      )
      await owner.query(upgrade)
      const after = await owner.query(
        "SELECT seal_bytes FROM lyrashield_authority.seal WHERE epoch_id=$1",
        [epoch]
      )
      expect(after.rows).toEqual(retained.rows)
      expect(await mirror.readSealBounded(1, 16384)).toEqual(v1)
    } finally {
      await owner.query(upgrade)
    }
  })

  it("rejects malformed v2 positions and snapshot commitments even through direct SQL", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const first = append(epoch, supervisor)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    const base = sealFor(first.head)
    const v2 = {
      ...base,
      schema: "lyrashield-journal-seal/2",
      originalSegmentStartSequence: 1,
      originalByteOffset: 400,
      wrapperSegmentStartSequence: 1,
      wrapperByteOffset: 500,
      recoverySnapshotSha256: "e".repeat(64),
      recoverySnapshotBytes: 1024,
    }
    for (const mutation of [
      { originalSegmentStartSequence: 2 },
      { originalByteOffset: 0 },
      { wrapperSegmentStartSequence: 0 },
      { wrapperByteOffset: 64 * 1024 * 1024 + 1 },
      { recoverySnapshotSha256: "invalid" },
      { recoverySnapshotBytes: 0 },
      { recoverySnapshotBytes: 1024 * 1024 + 1 },
      { recoverySnapshotBytes: null },
    ]) {
      await expect(
        runtime.query("SELECT lyrashield_authority.append_seal($1,$2,'',$3,$4)", [
          epoch,
          supervisor,
          canonicalJson({ ...v2, ...mutation }),
          canonicalJson(first.head),
        ])
      ).rejects.toMatchObject({ code: "22023" })
    }
    await expect(
      runtime.query("SELECT lyrashield_authority.append_seal($1,$2,'',$3,$4)", [
        epoch,
        supervisor,
        canonicalJson({ ...base, recoverySnapshotBytes: 1024 }),
        canonicalJson(first.head),
      ])
    ).rejects.toMatchObject({ code: "22023" })
    expect(await mirror.readSealHeadBounded(16384)).toBeNull()
  })

  it("serializes competing seals, rejects history tampering, and denies direct seal mutation", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const first = append(epoch, supervisor)
    expect(await mirror.compareAndAppend(null, first.head, first.record)).toBe("written")
    const left = sealFor(first.head)
    const { signature, sealHash, ...body } = left
    const rivalBody = { ...body, originalLastHash: "f".repeat(64) }
    const right = {
      ...rivalBody,
      sealHash: createHash("sha256").update(canonicalJson(rivalBody)).digest("hex"),
      signature,
    }
    const outcomes = await Promise.all([
      mirror.compareAndAppendSeal(null, left, first.head),
      mirror.compareAndAppendSeal(null, right, first.head),
    ])
    expect([...outcomes].sort()).toEqual(["conflict", "written"])
    expect(right.sealHash).not.toBe(sealHash)
    const winner = await mirror.readSealHeadBounded(16384)
    expect(winner).toEqual(outcomes[0] === "written" ? left : right)
    await expect(runtime.query("DELETE FROM lyrashield_authority.seal")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(
      runtime.query("UPDATE lyrashield_authority.seal_head SET seal_bytes='{}'")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      new PostgresAuthorityMirror(worker, epoch, supervisor).readSealHeadBounded(16384)
    ).rejects.toMatchObject({ code: "42501" })
    await owner.query("DELETE FROM lyrashield_authority.record WHERE epoch_id=$1", [epoch])
    await expect(mirror.compareAndAppendSeal(null, winner!, first.head)).resolves.toBe("conflict")
    expect(await mirror.readSealHeadBounded(16384)).toEqual(winner)
  })
  it("atomically persists exact bytes and replays the same operation after a lost acknowledgement", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const { head, record } = append(epoch, supervisor)
    const lostReply = new PostgresAuthorityMirror(
      {
        query: (text, values) => runtime.query(text, values),
        connect: async () => {
          const connection = await runtime.connect()
          return {
            query: async (text, values) => {
              const result = await connection.query(text, values)
              if (text === "COMMIT") throw new Error("commit reply lost")
              return result
            },
            release: (destroy) => connection.release(destroy),
          }
        },
      },
      epoch,
      supervisor
    )
    await expect(lostReply.compareAndAppend(null, head, record)).rejects.toThrow(
      "commit reply lost"
    )
    expect(await mirror.readHead()).toEqual(head)
    expect(await mirror.readRecord(1)).toEqual(record)
    expect(await mirror.compareAndAppend(null, head, record)).toBe("written")
    const count = await owner.query(
      "SELECT count(*) FROM lyrashield_authority.record WHERE epoch_id=$1",
      [epoch]
    )
    expect(count.rows[0].count).toBe("1")
  })

  it("serializes concurrent different starts and cannot overwrite a newer head on stale replay", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const left = append(epoch, supervisor)
    const right = append(epoch, supervisor)
    const results = await Promise.all([
      mirror.compareAndAppend(null, left.head, left.record),
      mirror.compareAndAppend(null, right.head, right.record),
    ])
    expect(results.sort()).toEqual(["conflict", "written"])
    const first = (await mirror.readHead())!
    const second = append(epoch, supervisor, first)
    expect(await mirror.compareAndAppend(first, second.head, second.record)).toBe("written")
    const firstRecord = (await mirror.readRecord(1))!
    expect(await mirror.compareAndAppend(null, first, firstRecord)).toBe("conflict")
    expect(await mirror.readHead()).toEqual(second.head)
  })

  it("rejects missing or inactive epochs without provisioning or reopening them", async () => {
    const { epoch, supervisor, mirror } = await fixture(false)
    const event = append(epoch, supervisor)
    await expect(mirror.readHead()).rejects.toMatchObject({ code: "55000" })
    await expect(mirror.readSealHeadBounded(16384)).rejects.toMatchObject({ code: "55000" })
    await expect(mirror.readSealBounded(1, 16384)).rejects.toMatchObject({ code: "55000" })
    await expect(
      mirror.compareAndAppendSeal(null, sealFor(event.head), event.head)
    ).rejects.toMatchObject({
      code: "55000",
    })
    await expect(mirror.compareAndAppend(null, event.head, event.record)).rejects.toMatchObject({
      code: "55000",
    })
    await expect(
      new PostgresAuthorityMirror(runtime, "missing-epoch", supervisor).readHead()
    ).rejects.toMatchObject({ code: "55000" })
    const status = await owner.query(
      "SELECT active FROM lyrashield_authority.stream WHERE epoch_id=$1",
      [epoch]
    )
    expect(status.rows[0].active).toBe(false)
  })

  it("denies worker access and denies the mirror role direct history or epoch mutation", async () => {
    const { epoch, supervisor } = await fixture()
    await expect(
      new PostgresAuthorityMirror(worker, epoch, supervisor).readHead()
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      new PostgresAuthorityMirror(worker, epoch, supervisor).readHeadBounded(1024)
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      new PostgresAuthorityMirror(worker, epoch, supervisor).readRecordBounded(1, 1024)
    ).rejects.toMatchObject({ code: "42501" })
    await expect(runtime.query("DELETE FROM lyrashield_authority.record")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(
      runtime.query("UPDATE lyrashield_authority.stream SET active=true")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query("INSERT INTO lyrashield_authority.stream VALUES ('new','new',true,null)")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(runtime.query("SET ROLE authority_owner")).rejects.toMatchObject({ code: "42501" })
    const privilege = await owner.query(
      "SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='authority_owner'"
    )
    expect(privilege.rows[0]).toEqual({
      rolname: "authority_owner",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolcanlogin: false,
    })
    const owners = await owner.query(
      "SELECT pg_get_userbyid(proowner) AS name,proconfig FROM pg_proc WHERE pronamespace='lyrashield_authority'::regnamespace"
    )
    expect(owners.rows).toHaveLength(6)
    for (const fn of owners.rows)
      expect(fn).toEqual({ name: "authority_owner", proconfig: ["search_path=pg_catalog"] })
  })

  it("enforces UTF-8 caller limits in SQL without sending oversized text to the driver", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const event = append(epoch, supervisor)
    Reflect.set(event.record.payload as object, "payload", { value: "é".repeat(1024) })
    expect(await mirror.compareAndAppend(null, event.head, event.record)).toBe("written")
    const headBytes = canonicalJson(event.head),
      recordBytes = canonicalJson(event.record)
    const headLimit = Buffer.byteLength(headBytes),
      recordLimit = Buffer.byteLength(recordBytes)
    expect(await mirror.readHeadBounded(headLimit)).toEqual(event.head)
    expect(canonicalJson(await mirror.readRecordBounded(1, recordLimit))).toBe(recordBytes)
    await expect(mirror.readHeadBounded(headLimit - 1)).rejects.toThrow("requested byte limit")
    const transferred: Record<string, unknown>[] = []
    const guarded = new PostgresAuthorityMirror(
      {
        query: (sql, values) => runtime.query(sql, values),
        connect: async () => {
          const connection = await runtime.connect()
          return {
            query: async (sql, values) => {
              const result = await connection.query(sql, values)
              if (sql.startsWith("WITH evidence")) transferred.push(...result.rows)
              return result
            },
            release: (destroy) => connection.release(destroy),
          }
        },
      },
      epoch,
      supervisor
    )
    await expect(guarded.readRecordBounded(1, recordLimit - 1)).rejects.toThrow(
      "requested byte limit"
    )
    expect(transferred).toEqual([{ bytes: null, oversized: true }])
    expect(await mirror.readRecordBounded(2, 1)).toBeNull()
    const empty = await fixture()
    expect(await empty.mirror.readHeadBounded(1)).toBeNull()
  })

  it("rolls record and head back together without leaving a partial append", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const event = append(epoch, supervisor)
    const client = await runtime.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        "SELECT lyrashield_authority.append_record($1,$2,'',$3,$4) AS status",
        [epoch, supervisor, canonicalJson(event.head), canonicalJson(event.record)]
      )
      expect(result.rows[0].status).toBe("written")
      expect(await mirror.readHead()).toBeNull()
      await client.query("ROLLBACK")
    } finally {
      client.release()
    }
    expect(await mirror.readHead()).toBeNull()
    expect(await mirror.readRecord(1)).toBeNull()
  })

  it("preserves prototype-key bytes and rejects foreign, malformed or oversized input", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const event = append(epoch, supervisor)
    Reflect.set(
      event.record,
      "payload",
      JSON.parse(
        canonicalJson(event.record.payload).replace('"START"', '{"__proto__":{"admin":true}}')
      )
    )
    expect(await mirror.compareAndAppend(null, event.head, event.record)).toBe("written")
    expect(canonicalJson(await mirror.readRecord(1))).toBe(canonicalJson(event.record))
    const next = append(epoch, supervisor, event.head)
    await expect(
      mirror.compareAndAppend(event.head, { ...next.head, workspaceId: "foreign" }, next.record)
    ).rejects.toThrow("binding mismatch")
    await expect(
      mirror.compareAndAppend(null, { ...event.head, epochId: "foreign" }, event.record)
    ).rejects.toThrow("identity mismatch")
    await expect(
      mirror.compareAndAppend(event.head, next.head, {
        ...next.record,
        payload: { ...(next.record.payload as object), payload: "x".repeat(4194305) },
      })
    ).rejects.toThrow("exceeds limit")
    await expect(
      runtime.query("SELECT lyrashield_authority.append_record($1,$2,'','{}','{}')", [
        epoch,
        supervisor,
      ])
    ).rejects.toMatchObject({ code: "22023" })
  })

  it("holds the signed three-way journal after a database rollback without rewriting local or remote history", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const root = await mkdtemp(join(tmpdir(), "authority-mirror-"))
    const schema = z.object({ action: z.string() }).strict()
    const local = new SignedJournal(join(root, "journal.jsonl"), "l".repeat(48), (value) =>
      authorityEventSchema(schema).parse(value)
    )
    const objects = new Map<string, StoredObject>()
    let writes = 0
    const store: ConditionalObjectStore = {
      read: async (key) => objects.get(key) ?? null,
      put: async (key, bytes, condition) => {
        const previous = objects.get(key)
        if (
          ("ifNoneMatch" in condition && previous) ||
          ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
        )
          return "conflict"
        objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++writes}` })
        return "written"
      },
    }
    const journal = new IndependentAuthorityJournal({
      local,
      store,
      mirror,
      epochId: epoch,
      supervisorInstanceId: supervisor,
      signingSecret: "r".repeat(48),
      payloadSchema: schema,
      authorize: async () => true,
    })
    const event = {
      epochId: epoch,
      operationId: "operation-1",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      attemptId: "attempt-1",
      eventId: "start-1",
      payload: { action: "START" },
    }
    try {
      const first = await journal.appendIntent(event)
      expect(await mirror.readRecord(1)).toEqual(first)
      const remote = Array.from(objects.entries()).map(([key, value]) => [
        key,
        Buffer.from(value.bytes).toString("hex"),
      ])
      await owner.query("DELETE FROM lyrashield_authority.record WHERE epoch_id=$1", [epoch])
      await owner.query(
        "UPDATE lyrashield_authority.stream SET head_bytes=null WHERE epoch_id=$1",
        [epoch]
      )
      await expect(journal.appendIntent({ ...event, eventId: "start-2" })).rejects.toMatchObject({
        code: "AUTHORITY_CONFLICT",
      })
      expect(await local.load()).toEqual([first])
      expect(
        Array.from(objects.entries()).map(([key, value]) => [
          key,
          Buffer.from(value.bytes).toString("hex"),
        ])
      ).toEqual(remote)
      expect(await mirror.readHead()).toBeNull()
    } finally {
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("holds a lost real mirror ACK across rotated restart, then rejects a missing tail segment", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const root = await mkdtemp(join(tmpdir(), "authority-rotated-mirror-"))
    const path = join(root, "journal.jsonl")
    const schema = z.object({ action: z.string() }).strict()
    const objects = new Map<string, StoredObject>()
    let writes = 0
    const store: ConditionalObjectStore = {
      read: async (key) => objects.get(key) ?? null,
      put: async (key, bytes, condition) => {
        const previous = objects.get(key)
        if (
          ("ifNoneMatch" in condition && previous) ||
          ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
        )
          return "conflict"
        objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++writes}` })
        return "written"
      },
    }
    let loseCommit = false
    const observedMirror = new PostgresAuthorityMirror(
      {
        query: (sql, values) => runtime.query(sql, values),
        connect: async () => {
          const connection = await runtime.connect()
          let appending = false
          return {
            query: async (sql, values) => {
              if (sql.includes("lyrashield_authority.append_record")) appending = true
              const result = await connection.query(sql, values)
              if (sql === "COMMIT" && appending && loseCommit) {
                loseCommit = false
                throw new Error("actual commit succeeded but response lost")
              }
              return result
            },
            release: (destroy) => connection.release(destroy),
          }
        },
      },
      epoch,
      supervisor
    )
    const open = () => {
      const local = new SignedJournal(
        path,
        "l".repeat(48),
        (value) => authorityEventSchema(schema).parse(value),
        { maxSegmentBytes: 1024 }
      )
      return {
        local,
        journal: new IndependentAuthorityJournal({
          local,
          store,
          mirror: observedMirror,
          epochId: epoch,
          supervisorInstanceId: supervisor,
          signingSecret: "r".repeat(48),
          payloadSchema: schema,
          authorize: async () => true,
        }),
      }
    }
    let current = open()
    try {
      for (let index = 1; index <= 4; index++) {
        loseCommit = index === 4
        const append = current.journal.appendIntent({
          epochId: epoch,
          operationId: "operation-1",
          scanId: "scan-1",
          workspaceId: "workspace-1",
          attemptId: "attempt-1",
          eventId: `event-${index}`,
          payload: { action: "START" },
        })
        if (index === 4) await expect(append).rejects.toMatchObject({ code: "AUTHORITY_UNKNOWN" })
        else await append
      }
      const head = await mirror.readHead()
      expect(head?.sequence).toBe(4)
      const segments = (await readdir(root)).filter((name) =>
        name.startsWith("journal.jsonl.segment.")
      )
      expect(segments.length).toBeGreaterThan(0)
      await current.local.close()
      current = open()
      await expect(current.journal.loadConfirmed()).rejects.toMatchObject({
        code: "REPLAY_REQUIRED",
      })
      await current.journal.appendIntent({
        epochId: epoch,
        operationId: "operation-1",
        scanId: "scan-1",
        workspaceId: "workspace-1",
        attemptId: "attempt-1",
        eventId: "event-4",
        payload: { action: "START" },
      })
      expect(await current.journal.loadConfirmed()).toHaveLength(4)
      const count = await owner.query(
        "SELECT count(*) FROM lyrashield_authority.record WHERE epoch_id=$1",
        [epoch]
      )
      expect(count.rows[0].count).toBe("4")
      await current.local.close()
      const tail = segments
        .sort((a, b) => Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)))
        .at(-1)!
      await rm(join(root, tail))
      current = open()
      await expect(current.journal.loadConfirmed()).rejects.toMatchObject({
        code: "AUTHORITY_CONFLICT",
      })
      expect(await mirror.readHead()).toEqual(head)
    } finally {
      await current.local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("publishes a seal to real PostgreSQL, replays the same lost ACK and audits exact archives", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const root = await mkdtemp(join(tmpdir(), "real-seal-publisher-"))
    const sourceKey = "o".repeat(48),
      wrapperKey = "w".repeat(48),
      sealKey = "s".repeat(48)
    const sourceSchema = z.object({ value: z.string() }).strict()
    const original = new SignedJournal(join(root, "original"), sourceKey, (value) =>
      sourceSchema.parse(value)
    )
    const wrapper = new SignedJournal(join(root, "wrapper"), wrapperKey, (value) =>
      authorityEventSchema(z.unknown()).parse(value)
    )
    function syntheticR2(bucket: string) {
      const objects = new Map<string, { bytes: Buffer; etag: string }>()
      let count = 0
      const client = {
        async send(command: GetObjectCommand | PutObjectCommand) {
          const key = command.input.Key!
          const current = objects.get(key)
          if (command instanceof GetObjectCommand) {
            if (!current) throw { $metadata: { httpStatusCode: 404 } }
            return {
              ETag: current.etag,
              ContentLength: current.bytes.length,
              Body: Readable.from([current.bytes]),
            }
          }
          if (
            (command.input.IfNoneMatch === "*" && current) ||
            (command.input.IfMatch && command.input.IfMatch !== current?.etag)
          )
            throw { $metadata: { httpStatusCode: 412 } }
          objects.set(key, {
            bytes: Buffer.from(command.input.Body as Uint8Array),
            etag: `"etag-${++count}"`,
          })
          return {}
        },
      }
      return {
        objects,
        store: new R2ConditionalObjectStore(client as unknown as Pick<S3Client, "send">, bucket),
      }
    }
    const remote = syntheticR2("journal-evidence"),
      control = syntheticR2("control-evidence")
    let loseSealReply = false
    const observedMirror = new PostgresAuthorityMirror(
      {
        query: (sql, values) => runtime.query(sql, values),
        connect: async () => {
          const connection = await runtime.connect()
          let sealAppend = false
          return {
            query: async (sql, values) => {
              if (sql.includes("lyrashield_authority.append_seal")) sealAppend = true
              const result = await connection.query(sql, values)
              if (sql === "COMMIT" && sealAppend && loseSealReply) {
                loseSealReply = false
                throw new Error("real seal commit reply lost")
              }
              return result
            },
            release: (destroy) => connection.release(destroy),
          }
        },
      },
      epoch,
      supervisor
    )
    const independent = new IndependentAuthorityJournal({
      local: wrapper,
      store: remote.store,
      mirror: observedMirror,
      epochId: epoch,
      supervisorInstanceId: supervisor,
      signingSecret: wrapperKey,
      payloadSchema: z.unknown(),
      authorize: async () => true,
    })
    try {
      for (let index = 1; index <= 3; index++) {
        const record = await original.append({ value: `record-${index}` })
        await independent.appendIntent({
          epochId: epoch,
          operationId: "operation-1",
          scanId: "scan-1",
          workspaceId: "workspace-1",
          attemptId: "attempt-1",
          eventId: `source-${index}`,
          payload: record,
        })
      }
      const evidence = new StoredJournalSealEvidenceReader({
        epochId: epoch,
        supervisorInstanceId: supervisor,
        store: remote.store,
        mirror: observedMirror,
        headSigningSecret: wrapperKey,
        sealSigningSecret: sealKey,
        originalSigningSecret: sourceKey,
        wrapperSigningSecret: wrapperKey,
        validateOriginal: (value) => sourceSchema.parse(value),
      })
      const genesis = {
        schema: "lyrashield-root-control-seal-genesis/1",
        productRevision: "a".repeat(40),
        epochId: epoch,
        supervisorInstanceId: supervisor,
      }
      const genesisBytes = Buffer.from(
        canonicalJson({
          ...genesis,
          signature: createHmac("sha256", sealKey).update(canonicalJson(genesis)).digest("hex"),
        })
      )
      await control.store.put(`journal-seal-pins/${epoch}/${supervisor}/current`, genesisBytes, {
        ifNoneMatch: true,
      })
      const options = {
        epochId: epoch,
        supervisorInstanceId: supervisor,
        epoch: 1,
        productRevision: "a".repeat(40),
        checkpointSecret: sealKey,
        checkpointKeyHash: createHash("sha256").update(sealKey).digest("hex"),
        controlAccountId: "a".repeat(32),
        controlBucket: "control-evidence",
        genesisRecordHash: createHash("sha256").update(genesisBytes).digest("hex"),
      }
      const gate = {
        withAuthorizedStream: async <T>(
          _stream: unknown,
          fn: (proof: {
            policy: typeof options & {
              authorityDigest: string
              runtimePolicyDigest: string
              databaseRole: "lyrashield_journal_seal_control"
            }
            assertActive(): void
          }) => Promise<T>
        ) =>
          fn({
            policy: {
              ...options,
              authorityDigest: `sha256:${"a".repeat(64)}`,
              runtimePolicyDigest: `sha256:${"b".repeat(64)}`,
              databaseRole: "lyrashield_journal_seal_control" as const,
            },
            assertActive: () => undefined,
          }),
      }
      const pin = new ProtectedJournalSealPinStore(control.store, evidence, gate, options)
      const publisher = new JournalSealPublisher({
        epochId: epoch,
        supervisorInstanceId: supervisor,
        original,
        wrapper,
        independent,
        store: remote.store,
        mirror: observedMirror,
        pin,
        headSigningSecret: wrapperKey,
        sealSigningSecret: sealKey,
        originalSigningSecret: sourceKey,
        wrapperSigningSecret: wrapperKey,
        validateOriginal: (value) => sourceSchema.parse(value),
        recoverySnapshot: {
          create: async (input) => ({
            bytes: Buffer.from(
              canonicalJson({
                schema: "lyrashield-supervisor-recovery-snapshot/1",
                epochId: input.epochId,
                supervisorInstanceId: input.supervisorInstanceId,
                sequence: input.lastSequence,
                originalHash: input.originalLastHash,
                wrapperHash: input.wrapperLastHash,
                attempts: [],
                commands: [],
              })
            ),
            sequence: input.lastSequence,
            originalLastHash: input.originalLastHash,
            wrapperLastHash: input.wrapperLastHash,
          }),
        },
        fence: { run: async (fn) => fn(() => undefined) },
      })
      loseSealReply = true
      let pending: JournalSealPendingError | undefined
      try {
        await publisher.publishNext()
      } catch (error) {
        if (!(error instanceof JournalSealPendingError)) throw error
        pending = error
      }
      expect(pending?.sealHash).toMatch(/^[a-f0-9]{64}$/)
      expect(await mirror.readSealHeadBounded(16384)).not.toBeNull()
      expect(
        [...remote.objects.keys()].some((key) => key.includes("/seal-acknowledgements/"))
      ).toBe(false)
      expect(await pin.readCurrent({ epochId: epoch, supervisorInstanceId: supervisor })).toBeNull()
      const seal = await publisher.publishNext({ resumeSealHash: pending!.sealHash })
      expect(seal.sealHash).toBe(pending!.sealHash)
      expect(await mirror.readSealHeadBounded(16384)).toEqual(seal)
      expect(
        (await pin.readCurrent({ epochId: epoch, supervisorInstanceId: supervisor }))?.sealHash
      ).toBe(seal.sealHash)
      expect(
        (
          await auditJournalSealArchives(seal, remote.store, {
            originalSigningSecret: sourceKey,
            wrapperSigningSecret: wrapperKey,
            sealSigningSecret: sealKey,
            validateOriginal: (value) => sourceSchema.parse(value),
          })
        ).originals
      ).toHaveLength(3)
      const next = await original.append({ value: "record-4" })
      await independent.appendIntent({
        epochId: epoch,
        operationId: "operation-1",
        scanId: "scan-1",
        workspaceId: "workspace-1",
        attemptId: "attempt-1",
        eventId: "source-4",
        payload: next,
      })
      const continuation = {
        stream: { epochId: epoch, supervisorInstanceId: supervisor },
        pin,
        evidence,
        originalPath: join(root, "original"),
        wrapperPath: join(root, "wrapper"),
        originalSigningSecret: sourceKey,
        wrapperSigningSecret: wrapperKey,
        sealSigningSecret: sealKey,
        validateOriginal: (value: unknown) => sourceSchema.parse(value),
        authorize: async () => true,
      }
      expect(
        await withVerifiedJournalContinuation(
          continuation,
          async ({ originalTail }) => originalTail.records
        )
      ).toEqual([next])
      remote.objects.delete(`epochs/${epoch}/supervisors/${supervisor}/acknowledgements/4`)
      await expect(withVerifiedJournalContinuation(continuation, async () => true)).rejects.toThrow(
        /acknowledgement|unavailable/
      )
      remote.objects.delete(
        `epochs/${epoch}/supervisors/${supervisor}/seal-segments/${seal.sealHash}/original`
      )
      await expect(withVerifiedJournalContinuation(continuation, async () => true)).rejects.toThrow(
        /archive|unavailable/
      )
    } finally {
      await original.close()
      await wrapper.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("exercises 70 independently mirrored records across rotation, restart and full restore", async () => {
    const { epoch, supervisor, mirror } = await fixture()
    const root = await mkdtemp(join(tmpdir(), "authority-sustained-mirror-"))
    const restoreRoot = await mkdtemp(join(tmpdir(), "authority-sustained-restore-"))
    const schema = z.object({ action: z.string() }).strict()
    const objects = new Map<string, StoredObject>()
    const metrics = { objectReads: 0, objectBytes: 0, mirrorReads: 0, mirrorBytes: 0 }
    let writes = 0
    const store: ConditionalObjectStore = {
      read: async (key) => {
        const value = objects.get(key) ?? null
        metrics.objectReads += 1
        metrics.objectBytes += value?.bytes.byteLength ?? 0
        return value
      },
      put: async (key, bytes, condition) => {
        const previous = objects.get(key)
        if (
          ("ifNoneMatch" in condition && previous) ||
          ("ifMatch" in condition && previous?.etag !== condition.ifMatch)
        )
          return "conflict"
        objects.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++writes}` })
        return "written"
      },
    }
    const measuredMirror = {
      readHead: () => mirror.readHead(),
      readRecord: async (sequence: number) => {
        const value = await mirror.readRecord(sequence)
        metrics.mirrorReads += 1
        metrics.mirrorBytes += value ? Buffer.byteLength(canonicalJson(value)) : 0
        return value
      },
      compareAndAppend: (
        previous: AuthorityHead | null,
        head: AuthorityHead,
        record: JournalRecord<unknown>
      ) => mirror.compareAndAppend(previous, head, record),
    }
    const openJournal = (directory: string) => {
      const local = new SignedJournal(
        join(directory, "journal.jsonl"),
        "l".repeat(48),
        (value) => authorityEventSchema(schema).parse(value),
        { maxSegmentBytes: 8192 }
      )
      const journal = new IndependentAuthorityJournal({
        local,
        store,
        mirror: measuredMirror,
        epochId: epoch,
        supervisorInstanceId: supervisor,
        signingSecret: "r".repeat(48),
        payloadSchema: schema,
        authorize: async () => true,
      })
      return { local, journal }
    }
    let current = openJournal(root)
    const started = performance.now()
    let firstMs = 0
    let lastMs = 0
    try {
      for (let index = 1; index <= 70; index += 1) {
        const start = performance.now()
        await current.journal.appendIntent({
          epochId: epoch,
          operationId: "operation-1",
          scanId: "scan-1",
          workspaceId: "workspace-1",
          attemptId: "attempt-1",
          eventId: `event-${index}`,
          payload: { action: "START" },
        })
        if (index === 1) firstMs = performance.now() - start
        if (index === 70) lastMs = performance.now() - start
      }
      expect((await readdir(root)).some((name) => name.startsWith("journal.jsonl.segment."))).toBe(
        true
      )
      expect(await current.journal.loadConfirmed()).toHaveLength(70)
      await current.local.close()
      current = openJournal(root)
      expect(await current.journal.loadConfirmed()).toHaveLength(70)
      await current.local.close()
      for (const name of await readdir(root))
        await copyFile(join(root, name), join(restoreRoot, name))
      current = openJournal(restoreRoot)
      expect(await current.journal.loadConfirmed()).toHaveLength(70)
      await current.local.close()
      const segment = (await readdir(root))
        .filter((name) => name.startsWith("journal.jsonl.segment."))
        .sort((a, b) => Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)))
        .at(-1)!
      await rm(join(root, segment))
      current = openJournal(root)
      await expect(current.journal.loadConfirmed()).rejects.toMatchObject({
        code: "AUTHORITY_CONFLICT",
      })
      // Synthetic events and memory-backed object storage; PG is the isolated real fixture.
      process.stdout.write(
        `authority-70-record-observation ${JSON.stringify({
          elapsedMs: Math.round(performance.now() - started),
          firstAppendMs: Math.round(firstMs),
          lastAppendMs: Math.round(lastMs),
          ...metrics,
        })}\n`
      )
    } finally {
      await current.local.close().catch(() => undefined)
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(restoreRoot, { recursive: true, force: true }),
      ])
    }
  }, 300_000)
})
