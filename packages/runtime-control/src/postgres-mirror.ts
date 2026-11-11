import { z } from "zod"
import { performance } from "node:perf_hooks"
import { canonicalJson } from "./canonical-json"
import {
  authorityEventSchema,
  headSchema,
  type AuthorityHead,
  type AuthorityMirror,
  type BoundedAuthorityMirror,
} from "./independent-journal"
import type { JournalRecord } from "./journal"

/** A caller-owned, separately credentialed PostgreSQL client. Never use the worker pool. */
export interface AuthoritySqlClient {
  query(text: string, values: string[]): Promise<{ rows: Record<string, unknown>[] }>
}
export interface AuthoritySqlConnection extends AuthoritySqlClient {
  release(destroy?: boolean): void
}
export interface AuthoritySqlPool extends AuthoritySqlClient {
  /** Must check out a fresh idle connection, never a caller's transaction. */
  connect(): Promise<AuthoritySqlConnection>
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const recordSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().safe(),
    previousHash: hash,
    hash,
    signature: hash,
    payload: authorityEventSchema(z.unknown()),
  })
  .strict()
const MAX_BYTES = 4 * 1024 * 1024

function encode(value: unknown): string {
  const bytes = canonicalJson(value)
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("authority mirror input exceeds limit")
  return bytes
}

function decode(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES) {
    throw new Error("authority mirror returned invalid bytes")
  }
  const parsed: unknown = JSON.parse(value)
  if (encode(parsed) !== value) throw new Error("authority mirror returned noncanonical bytes")
  return parsed
}

function readLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw new Error("invalid authority mirror read byte limit")
  return maxBytes
}

function boundedBytes(
  result: { rows: Record<string, unknown>[] },
  maxBytes: number
): unknown | null {
  const row = result.rows[0]
  if (!row || typeof row.oversized !== "boolean")
    throw new Error("authority mirror returned invalid bounded response")
  if (row.oversized) throw new Error("authority mirror exceeds requested byte limit")
  if (row.bytes === null) return null
  if (typeof row.bytes !== "string" || Buffer.byteLength(row.bytes) > maxBytes)
    throw new Error("authority mirror returned invalid bounded bytes")
  return decode(row.bytes)
}

/**
 * PostgreSQL is a mirror, never authority to resume an epoch after a restore.
 * Stream provisioning and signing are outside this adapter. The caller must
 * authenticate all returned bytes against the local and independent journals.
 * SQL errors (including a lost commit reply) propagate as UNKNOWN to that caller.
 */
export class PostgresAuthorityMirror implements AuthorityMirror, BoundedAuthorityMirror {
  constructor(
    private readonly client: AuthoritySqlPool,
    private readonly epochId: string,
    private readonly supervisorInstanceId: string
  ) {
    id.parse(epochId)
    id.parse(supervisorInstanceId)
  }

  private bind(head: AuthorityHead): void {
    if (head.epochId !== this.epochId || head.supervisorInstanceId !== this.supervisorInstanceId) {
      throw new Error("authority mirror stream identity mismatch")
    }
  }

  private async transaction<T>(
    operation: (connection: AuthoritySqlConnection) => Promise<T>
  ): Promise<T> {
    let expired = false
    let connection: AuthoritySqlConnection | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failed = true
    const expiresAt = performance.now() + 10000
    const assertActive = () => {
      if (expired || performance.now() >= expiresAt) {
        expired = true
        throw new Error("authority mirror outcome is unavailable after timeout")
      }
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(new Error("authority mirror outcome is unavailable after timeout"))
      }, 10000)
    })
    // A connection arriving after acquisition timeout is discarded without running SQL.
    const pending = Promise.resolve()
      .then(() => this.client.connect())
      .then((value) => {
        if (expired || performance.now() >= expiresAt) {
          value.release(true)
          assertActive()
        }
        return value
      })
    try {
      connection = await Promise.race([pending, deadline])
      const acquired = connection
      const active: AuthoritySqlConnection = {
        query: async (text, values) => {
          assertActive()
          const value = await acquired.query(text, values)
          assertActive()
          return value
        },
        release: (destroy) => acquired.release(destroy),
      }
      const result = await Promise.race([
        (async () => {
          await active.query("BEGIN", [])
          // Local WAL completion is necessary, but does not qualify managed failover.
          await active.query("SET LOCAL synchronous_commit = 'on'", [])
          await active.query("SET LOCAL statement_timeout = '5000ms'", [])
          await active.query("SET LOCAL lock_timeout = '3000ms'", [])
          const value = await operation(active)
          await active.query("COMMIT", [])
          return value
        })(),
        deadline,
      ])
      assertActive()
      failed = false
      return result
    } finally {
      if (timer) clearTimeout(timer)
      // Destroy immediately on error. Waiting for ROLLBACK on a lost socket can
      // hide UNKNOWN forever; disconnect aborts any uncommitted transaction.
      connection?.release(failed)
    }
  }

  async readHead(): Promise<AuthorityHead | null> {
    const result = await this.transaction((connection) =>
      connection.query("SELECT lyrashield_authority.read_head($1, $2) AS bytes", [
        this.epochId,
        this.supervisorInstanceId,
      ])
    )
    const bytes = result.rows[0]?.bytes
    if (bytes === null) return null
    const head = headSchema.parse(decode(bytes))
    this.bind(head)
    return head
  }

  async readRecord(sequence: number): Promise<JournalRecord<unknown> | null> {
    z.number().int().positive().safe().parse(sequence)
    const result = await this.transaction((connection) =>
      connection.query("SELECT lyrashield_authority.read_record($1, $2, $3::bigint) AS bytes", [
        this.epochId,
        this.supervisorInstanceId,
        String(sequence),
      ])
    )
    const bytes = result.rows[0]?.bytes
    if (bytes === null) return null
    const record = recordSchema.parse(decode(bytes))
    if (record.sequence !== sequence || record.payload.epochId !== this.epochId) {
      throw new Error("authority mirror record identity mismatch")
    }
    return record
  }

  async readHeadBounded(maxBytes: number): Promise<AuthorityHead | null> {
    readLimit(maxBytes)
    const result = await this.transaction((connection) =>
      connection.query(
        `WITH evidence AS MATERIALIZED (SELECT lyrashield_authority.read_head($1,$2) AS bytes)
         SELECT CASE WHEN octet_length(bytes) <= $3::integer THEN bytes END AS bytes,
                COALESCE(octet_length(bytes) > $3::integer, false) AS oversized FROM evidence`,
        [this.epochId, this.supervisorInstanceId, String(maxBytes)]
      )
    )
    const value = boundedBytes(result, maxBytes)
    if (value === null) return null
    const head = headSchema.parse(value)
    this.bind(head)
    return head
  }

  async readRecordBounded(
    sequence: number,
    maxBytes: number
  ): Promise<JournalRecord<unknown> | null> {
    z.number().int().positive().safe().parse(sequence)
    readLimit(maxBytes)
    const result = await this.transaction((connection) =>
      connection.query(
        `WITH evidence AS MATERIALIZED (SELECT lyrashield_authority.read_record($1,$2,$3::bigint) AS bytes)
         SELECT CASE WHEN octet_length(bytes) <= $4::integer THEN bytes END AS bytes,
                COALESCE(octet_length(bytes) > $4::integer, false) AS oversized FROM evidence`,
        [this.epochId, this.supervisorInstanceId, String(sequence), String(maxBytes)]
      )
    )
    const value = boundedBytes(result, maxBytes)
    if (value === null) return null
    const record = recordSchema.parse(value)
    if (record.sequence !== sequence || record.payload.epochId !== this.epochId)
      throw new Error("authority mirror record identity mismatch")
    return record
  }

  async compareAndAppend(
    previous: AuthorityHead | null,
    head: AuthorityHead,
    record: JournalRecord<unknown>
  ): Promise<"written" | "conflict"> {
    const parsedHead = headSchema.parse(head)
    const parsedRecord = recordSchema.parse(record)
    this.bind(parsedHead)
    if (previous) this.bind(headSchema.parse(previous))
    if (
      head.sequence !== (previous?.sequence ?? 0) + 1 ||
      head.previousHash !== (previous?.recordHash ?? "0".repeat(64)) ||
      head.sequence !== record.sequence ||
      head.previousHash !== record.previousHash ||
      head.recordHash !== record.hash ||
      ["epochId", "operationId", "scanId", "workspaceId", "attemptId", "eventId"].some(
        (key) => Reflect.get(parsedHead, key) !== Reflect.get(parsedRecord.payload, key)
      )
    ) {
      throw new Error("authority mirror append binding mismatch")
    }
    const values = [
      this.epochId,
      this.supervisorInstanceId,
      previous ? encode(previous) : "",
      encode(head),
      encode(record),
    ]
    return this.transaction(async (connection) => {
      const result = await connection.query(
        "SELECT lyrashield_authority.append_record($1, $2, $3, $4, $5) AS status",
        values
      )
      const status = result.rows[0]?.status
      if (status !== "written" && status !== "conflict") {
        throw new Error("authority mirror append response is unavailable")
      }
      return status
    })
  }
}
