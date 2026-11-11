import { z } from "zod"
import { canonicalJson } from "./canonical-json"
import {
  authorityEventSchema,
  headSchema,
  type AuthorityHead,
  type AuthorityMirror,
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

/**
 * PostgreSQL is a mirror, never authority to resume an epoch after a restore.
 * Stream provisioning and signing are outside this adapter. The caller must
 * authenticate all returned bytes against the local and independent journals.
 * SQL errors (including a lost commit reply) propagate as UNKNOWN to that caller.
 */
export class PostgresAuthorityMirror implements AuthorityMirror {
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
        if (expired) value.release(true)
        return value
      })
    try {
      connection = await Promise.race([pending, deadline])
      const acquired = connection
      const active: AuthoritySqlConnection = {
        query: async (text, values) => {
          if (expired) throw new Error("authority mirror transaction expired")
          const value = await acquired.query(text, values)
          if (expired) throw new Error("authority mirror transaction expired")
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
