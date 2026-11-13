import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import {
  AuthorityFenceError,
  PostgresScanAuthorityFence,
  type AuthorityAction,
} from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"

const binding: AuthorityAction = {
  phase: "EXECUTOR_CREATE",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  commandId: "command-1",
  executorKey: "engine",
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
}
afterEach(() => vi.useRealTimers())

function fixture() {
  const events = new EventEmitter()
  const connection = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    query: vi.fn(async (text: string): Promise<{ rows: Record<string, unknown>[] }> => ({
      rows: text.includes("acquire_scan")
        ? [{ acquired: true }]
        : text.includes("gate_held")
          ? [{ held: true, nowMs: String(Date.now()) }]
          : [],
    })),
    release: vi.fn(),
  }
  const pool = {
    query: connection.query,
    connect: vi.fn<() => Promise<AuthoritySqlConnection>>(async () => connection),
  }
  const verify = vi.fn(async (_connection: AuthoritySqlConnection, _binding: AuthorityAction) => ({
    deadlineAt: new Date(Date.now() + 1000),
  }))
  const fence = new PostgresScanAuthorityFence(pool, verify)
  return { connection, pool, verify, fence, events }
}

describe("native scan action fence", () => {
  it("keeps one native transaction through authority verification and invocation", async () => {
    const f = fixture()
    const effect = vi.fn((assertActive: () => void) => {
      assertActive()
      expect(f.verify).toHaveBeenCalledOnce()
      expect(f.connection.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false)
      expect(f.connection.release).not.toHaveBeenCalled()
      return "created"
    })
    expect(await f.fence.run(binding, effect)).toBe("created")
    expect(effect).toHaveBeenCalledOnce()
    expect(f.connection.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.verify.mock.calls[0]?.[1]).toEqual(binding)
  })

  it.each([false, undefined])("rejects an absent native writer gate (%s)", async (acquired) => {
    const f = fixture(),
      effect = vi.fn()
    f.connection.query.mockResolvedValue({ rows: [{ acquired }] })
    await expect(f.fence.run(binding, effect)).rejects.toBeInstanceOf(AuthorityFenceError)
    expect(f.verify).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("does not invoke after revoked native authority", async () => {
    const f = fixture(),
      effect = vi.fn()
    f.verify.mockRejectedValue(new Error("membership revoked"))
    await expect(f.fence.run(binding, effect)).rejects.toThrow("membership revoked")
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each([new Date(0), new Date(NaN)])(
    "rejects expired or invalid authority deadlines (%s)",
    async (deadlineAt) => {
      const f = fixture(),
        effect = vi.fn()
      f.verify.mockResolvedValue({ deadlineAt })
      await expect(f.fence.run(binding, effect)).rejects.toBeInstanceOf(AuthorityFenceError)
      expect(effect).not.toHaveBeenCalled()
    }
  )

  it("rejects loss of the native lock after checking authority", async () => {
    const f = fixture(),
      effect = vi.fn()
    f.connection.query.mockImplementation(async (text) => ({
      rows: text.includes("acquire_scan")
        ? [{ acquired: true }]
        : text.includes("gate_held")
          ? [{ held: false, nowMs: String(Date.now()) }]
          : [],
    }))
    await expect(f.fence.run(binding, effect)).rejects.toBeInstanceOf(AuthorityFenceError)
    expect(effect).not.toHaveBeenCalled()
  })

  it("never retries an effect after a lost rollback acknowledgement", async () => {
    const f = fixture(),
      effect = vi.fn(() => "created")
    const query = f.connection.query.getMockImplementation()!
    f.connection.query.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw new Error("reply lost")
      return query(text)
    })
    await expect(f.fence.run(binding, effect)).rejects.toThrow("reply lost")
    expect(effect).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("expires a stalled effect and invalidates delayed invocations", async () => {
    vi.useFakeTimers()
    const f = fixture()
    let assertActive: () => void = () => {
      throw new Error("not invoked")
    }
    const effect = vi.fn((check: () => void) => {
      assertActive = check
      return new Promise(() => undefined)
    })
    const outcome = f.fence.run(binding, effect).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await outcome).toBeInstanceOf(AuthorityFenceError)
    expect(effect).toHaveBeenCalledOnce()
    expect(assertActive).toThrow(AuthorityFenceError)
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("discards a connection arriving after acquisition timeout without executing SQL", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      effect = vi.fn()
    let resolve!: (connection: AuthoritySqlConnection) => void
    f.pool.connect.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const outcome = f.fence.run(binding, effect).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await outcome).toBeInstanceOf(AuthorityFenceError)
    resolve(f.connection)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.connection.query).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(effect).not.toHaveBeenCalled()
  })

  it("invalidates the invocation guard after transaction completion", async () => {
    const f = fixture()
    const check = await f.fence.run(binding, (assertActive) => assertActive)
    expect(check).toThrow(AuthorityFenceError)
  })

  it("prevents dispatch when the native session closes after its authority read", async () => {
    const f = fixture(),
      effect = vi.fn()
    f.verify.mockImplementation(async () => {
      f.events.emit("end")
      return { deadlineAt: new Date(Date.now() + 1000) }
    })
    await expect(f.fence.run(binding, effect)).rejects.toBeInstanceOf(AuthorityFenceError)
    expect(effect).not.toHaveBeenCalled()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("retains an invoked effect as uncertain when its native session closes", async () => {
    const f = fixture()
    let notify!: () => void, resume!: () => void
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const pause = new Promise<void>((resolve) => {
      resume = resolve
    })
    const effect = vi.fn(async (assertActive: () => void) => {
      assertActive()
      notify()
      await pause
      assertActive()
    })
    const outcome = f.fence.run(binding, effect).catch((error: unknown) => error)
    await entered
    f.events.emit("end")
    expect(await outcome).toBeInstanceOf(AuthorityFenceError)
    resume()
    expect(effect).toHaveBeenCalledOnce()
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each([
    { ...binding, workspaceId: ".." },
    { ...binding, commandId: undefined },
    { ...binding, executorKey: undefined },
    { ...binding, credentials: "untrusted" },
    { ...binding, phase: "PROVIDER_DISPATCH", requestId: "request-1" },
  ])("rejects malformed action identity before database access", async (input) => {
    const f = fixture(),
      effect = vi.fn()
    await expect(f.fence.run(input as AuthorityAction, effect)).rejects.toThrow()
    expect(f.pool.connect).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })
})
