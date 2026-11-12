import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe.skipIf(!enabled)("restricted PostgreSQL authority mirror", () => {
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
    expect(owners.rows).toHaveLength(3)
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
})
