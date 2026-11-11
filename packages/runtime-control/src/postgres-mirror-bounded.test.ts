import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import { canonicalJson } from "./canonical-json"
import { PostgresAuthorityMirror, type AuthoritySqlConnection } from "./postgres-mirror"

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const record = {
  version: 1,
  sequence: 1,
  previousHash: "0".repeat(64),
  hash: "a".repeat(64),
  signature: "b".repeat(64),
  payload: {
    epochId: "epoch-1",
    operationId: "operation-1",
    scanId: "scan-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
    eventId: "event-1",
    payload: { value: "é" },
  },
}
const head = {
  schema: "lyrashield-independent-authority-head/1",
  supervisorInstanceId: "supervisor-1",
  epochId: "epoch-1",
  operationId: "operation-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  attemptId: "attempt-1",
  eventId: "event-1",
  sequence: 1,
  previousHash: record.previousHash,
  recordHash: record.hash,
  signature: "c".repeat(64),
}
function fixture(row: Record<string, unknown> | null = { bytes: null, oversized: false }) {
  const active: AuthoritySqlConnection = {
    query: vi.fn(async (text) => ({ rows: text.startsWith("WITH evidence") && row ? [row] : [] })),
    release: vi.fn(),
  }
  const pool = { query: active.query, connect: vi.fn(async () => active) }
  return { active, pool, mirror: new PostgresAuthorityMirror(pool, "epoch-1", "supervisor-1") }
}

describe("caller-bounded PostgreSQL authority reads", () => {
  it.each(["head", "record"])(
    "projects bounded %s bytes in SQL and preserves exact canonical text",
    async (kind) => {
      const value = kind === "head" ? head : record
      const bytes = canonicalJson(value),
        limit = Buffer.byteLength(bytes)
      const f = fixture({ bytes, oversized: false })
      expect(
        await (kind === "head"
          ? f.mirror.readHeadBounded(limit)
          : f.mirror.readRecordBounded(1, limit))
      ).toEqual(value)
      expect(f.active.release).toHaveBeenCalledExactlyOnceWith(false)
      const query = vi
        .mocked(f.active.query)
        .mock.calls.find(([sql]) => sql.startsWith("WITH evidence"))!
      expect(query[0]).toContain("AS MATERIALIZED")
      expect(query[0]).toContain(
        `CASE WHEN octet_length(bytes) <= $${kind === "head" ? 3 : 4}::integer THEN bytes END`
      )
      expect(query[0]).toContain("AS oversized")
      expect(query[1]).toEqual(
        kind === "head"
          ? ["epoch-1", "supervisor-1", String(limit)]
          : ["epoch-1", "supervisor-1", "1", String(limit)]
      )
      expect(canonicalJson(value)).toBe(bytes)
    }
  )

  it.each(["head", "record"])(
    "distinguishes oversized %s from an authenticated missing row",
    async (kind) => {
      const missing = fixture(),
        oversized = fixture({ bytes: null, oversized: true })
      const read = (mirror: PostgresAuthorityMirror) =>
        kind === "head" ? mirror.readHeadBounded(16) : mirror.readRecordBounded(1, 16)
      await expect(read(missing.mirror)).resolves.toBeNull()
      await expect(read(oversized.mirror)).rejects.toThrow("exceeds requested byte limit")
      expect(missing.active.release).toHaveBeenCalledExactlyOnceWith(false)
      expect(oversized.active.release).toHaveBeenCalledExactlyOnceWith(true)
    }
  )

  it.each([0, -1, 1.5, Number.NaN, 4194305])(
    "rejects invalid read limit %s before connection acquisition",
    async (limit) => {
      const f = fixture()
      await expect(f.mirror.readHeadBounded(limit)).rejects.toThrow("byte limit")
      await expect(f.mirror.readRecordBounded(1, limit)).rejects.toThrow("byte limit")
      expect(f.pool.connect).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    { bytes: null },
    { bytes: null, oversized: "false" },
    { bytes: "x".repeat(17), oversized: false },
    { bytes: "{} ", oversized: false },
  ])("rejects malformed bounded evidence %j", async (row) => {
    const f = fixture(row)
    await expect(f.mirror.readHeadBounded(16)).rejects.toThrow()
    await expect(f.mirror.readRecordBounded(1, 16)).rejects.toThrow()
  })

  it("rejects valid-shaped foreign record and head identities", async () => {
    await expect(
      fixture({
        bytes: canonicalJson({ ...head, supervisorInstanceId: "foreign" }),
        oversized: false,
      }).mirror.readHeadBounded(1024)
    ).rejects.toThrow("identity mismatch")
    await expect(
      fixture({
        bytes: canonicalJson({ ...record, sequence: 2 }),
        oversized: false,
      }).mirror.readRecordBounded(1, 1024)
    ).rejects.toThrow("identity mismatch")
  })

  it.each(["acquire", "query", "commit"])(
    "rejects monotonic deadline expiry at %s even before timer delivery",
    async (boundary) => {
      vi.useFakeTimers()
      let now = 0
      vi.spyOn(performance, "now").mockImplementation(() => now)
      const f = fixture()
      if (boundary === "acquire")
        f.pool.connect.mockImplementation(async () => {
          now = 10001
          return f.active
        })
      else
        vi.mocked(f.active.query).mockImplementation(async (sql) => {
          if (
            (boundary === "query" && sql.startsWith("WITH evidence")) ||
            (boundary === "commit" && sql === "COMMIT")
          )
            now = 10001
          return { rows: [{ bytes: null, oversized: false }] }
        })
      await expect(f.mirror.readHeadBounded(16)).rejects.toThrow("timeout")
      expect(f.active.release).toHaveBeenCalledExactlyOnceWith(true)
      const queries = vi.mocked(f.active.query).mock.calls.map(([sql]) => sql)
      if (boundary === "acquire") expect(queries).toEqual([])
      if (boundary === "query") expect(queries).not.toContain("COMMIT")
      expect(queries).not.toContain("ROLLBACK")
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([
    { kind: "head", state: "missing" },
    { kind: "record", state: "missing" },
    { kind: "head", state: "present" },
    { kind: "record", state: "present" },
    { kind: "head", state: "oversized" },
    { kind: "record", state: "oversized" },
  ])(
    "rejects $state $kind when a microtask expires the read after the transaction check",
    async ({ kind, state }) => {
      vi.useFakeTimers()
      let now = 0,
        committed = false,
        checksAfterCommit = 0
      vi.spyOn(performance, "now").mockImplementation(() => {
        if (committed && ++checksAfterCommit === 2)
          queueMicrotask(() => {
            now = 10001
          })
        return now
      })
      const row = {
        bytes: state === "present" ? canonicalJson(kind === "head" ? head : record) : null,
        oversized: state === "oversized",
      }
      const f = fixture(row)
      vi.mocked(f.active.query).mockImplementation(async (sql) => {
        if (sql === "COMMIT") committed = true
        return { rows: sql.startsWith("WITH evidence") ? [row] : [] }
      })
      await expect(
        kind === "head" ? f.mirror.readHeadBounded(1024) : f.mirror.readRecordBounded(1, 1024)
      ).rejects.toThrow("timeout")
      expect(now).toBe(10001)
      expect(f.active.release).toHaveBeenCalledExactlyOnceWith(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
