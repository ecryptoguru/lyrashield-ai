import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { PostgresDurableScanAuthorityFence } from "./authority-invocation-fence"
import type { AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"
import { ScanAuthorityContext } from "./authority-context"

const binding: AuthorityAction = {
  phase: "SANDBOX_TOOL",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  commandId: "prepare-1",
  requestId: "request-1",
  executorKey: "sandbox",
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
}
function fixture(context?: ScanAuthorityContext) {
  const events = new EventEmitter()
  const calls: string[] = []
  let committed = false
  const connection = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    query: vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
      calls.push(sql)
      if (sql === "COMMIT") committed = true
      return {
        rows: sql.includes("NOT EXISTS")
          ? [{ clean: true }]
          : sql.includes("pg_try_advisory_lock")
            ? [{ acquired: true }]
            : sql.includes("scan_preparation_gate_held")
              ? [{ held: true, nowMs: String(Date.now()) }]
              : sql.includes("pg_advisory_unlock")
                ? [{ unlocked: true }]
                : [],
      }
    }),
    release: vi.fn(),
  }
  const pool = {
    query: connection.query,
    connect: async (): Promise<AuthoritySqlConnection> => connection,
  }
  const verify = vi.fn(async () => ({ deadlineAt: new Date(Date.now() + 5000) }))
  const guard = {
    begin: vi.fn(async () => ({ guardId: "guard-1" })),
    verifyCommitted: vi.fn(async () => {
      if (!committed) throw new Error("not committed")
    }),
  }
  return {
    calls,
    connection,
    events,
    guard,
    verify,
    fence: new PostgresDurableScanAuthorityFence(pool, verify, guard, context),
  }
}

describe("durable session invocation fence", () => {
  it("exposes only the active installed fence connection and expires captured async context", async () => {
    const context = new ScanAuthorityContext(),
      f = fixture(context)
    expect(context.current()).toBeUndefined()
    let delayed!: () => Promise<unknown>
    await f.fence.run(binding, async () => {
      const active = context.forOperation(binding.operationId)!
      expect(active.guardId).toBe("guard-1")
      expect(active.binding).toEqual(binding)
      expect(() => context.forOperation("foreign-operation")).toThrow()
      await active.connection.query("SELECT scoped_read", [])
      delayed = async () => active.connection.query("SELECT late_read", [])
    })
    expect(context.current()).toBeUndefined()
    await expect(delayed()).rejects.toThrow()
    expect(f.calls).toContain("SELECT scoped_read")
    expect(f.calls).not.toContain("SELECT late_read")
  })
  it("commits and verifies the original guard while holding the session gate through invocation", async () => {
    const f = fixture()
    const result = await f.fence.run(binding, (assertActive, context) => {
      assertActive()
      expect(context).toEqual({ guardId: "guard-1" })
      expect(f.guard.verifyCommitted).toHaveBeenCalledOnce()
      expect(f.connection.release).not.toHaveBeenCalled()
      expect(f.calls.filter((sql) => sql === "COMMIT")).toHaveLength(2)
      expect(f.calls.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(false)
      return "started"
    })
    expect(result).toBe("started")
    expect(f.calls[0]).toContain("NOT EXISTS")
    expect(f.calls[1]).toContain("pg_try_advisory_lock")
    expect(f.calls.at(-1)).toContain("pg_advisory_unlock")
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("does not invoke after a lost guard commit acknowledgement", async () => {
    const f = fixture()
    const query = f.connection.query.getMockImplementation()!
    f.connection.query.mockImplementation(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit acknowledgement lost")
      return query(sql)
    })
    const effect = vi.fn()
    await expect(f.fence.run(binding, effect)).rejects.toThrow("acknowledgement lost")
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("holds an already committed guard after session loss during a paused invocation", async () => {
    const f = fixture()
    let resume!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const late = vi.fn()
    const result = f.fence
      .run(binding, async (assertActive) => {
        started()
        await new Promise<void>((resolve) => {
          resume = resolve
        })
        assertActive()
        late()
      })
      .catch((error: unknown) => error)
    await startedPromise
    expect(f.guard.begin).toHaveBeenCalledOnce()
    expect(f.guard.verifyCommitted).toHaveBeenCalledOnce()
    f.events.emit("error", new Error("connection lost"))
    expect(await result).toBeInstanceOf(Error)
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
    resume()
    await Promise.resolve()
    expect(late).not.toHaveBeenCalled()
  })

  it("fails closed when the committed guard readback is unavailable", async () => {
    const f = fixture(),
      effect = vi.fn()
    f.guard.verifyCommitted.mockRejectedValueOnce(new Error("guard readback unavailable"))
    await expect(f.fence.run(binding, effect)).rejects.toThrow("guard readback unavailable")
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("rejects a reused session already holding the advisory gate", async () => {
    const f = fixture(),
      effect = vi.fn()
    const query = f.connection.query.getMockImplementation()!
    f.connection.query.mockImplementation(async (sql) =>
      sql.includes("NOT EXISTS") ? { rows: [{ clean: false }] } : query(sql)
    )
    await expect(f.fence.run(binding, effect)).rejects.toThrow()
    expect(f.guard.begin).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })
})
