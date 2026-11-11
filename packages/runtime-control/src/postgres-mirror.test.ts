import { afterEach, describe, expect, it, vi } from "vitest"
import { PostgresAuthorityMirror, type AuthoritySqlConnection } from "./postgres-mirror"

afterEach(() => vi.useRealTimers())

function connection() {
  return {
    query: vi.fn(async (text: string) => ({
      rows: [text.includes("append_record") ? { status: "written" } : { bytes: null }],
    })),
    release: vi.fn(),
  }
}

describe("PostgreSQL authority mirror deadlines and transport failures", () => {
  it("expires connection acquisition and discards a late connection without SQL", async () => {
    vi.useFakeTimers()
    let resolve!: (value: AuthoritySqlConnection) => void
    const active = connection()
    const mirror = new PostgresAuthorityMirror(
      {
        query: active.query,
        connect: () =>
          new Promise((value) => {
            resolve = value
          }),
      },
      "epoch-1",
      "supervisor-1"
    )
    const result = mirror.readHead().catch((error) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toMatchObject({ message: expect.stringContaining("timeout") })
    resolve(active)
    await vi.advanceTimersByTimeAsync(0)
    expect(active.release).toHaveBeenCalledWith(true)
    expect(active.query).not.toHaveBeenCalled()
  })

  it("bounds a stalled read and never commits after the late response", async () => {
    vi.useFakeTimers()
    const active = connection()
    let resolve!: (value: { rows: { bytes: null }[] }) => void
    active.query.mockImplementation(async (text) =>
      text.includes("read_head")
        ? new Promise((value) => {
            resolve = value
          })
        : { rows: [{ bytes: null }] }
    )
    const mirror = new PostgresAuthorityMirror(
      { query: active.query, connect: async () => active },
      "epoch-1",
      "supervisor-1"
    )
    const result = mirror.readHead().catch((error) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toMatchObject({ message: expect.stringContaining("timeout") })
    expect(active.release).toHaveBeenCalledTimes(1)
    expect(active.release).toHaveBeenCalledWith(true)
    resolve({ rows: [{ bytes: null }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(active.query.mock.calls.flat()).not.toContain("COMMIT")
  })

  it("propagates lost commit replies and destroys the connection without waiting for rollback", async () => {
    const active = connection()
    active.query.mockImplementation(async (text) => {
      if (text === "COMMIT") throw new Error("commit reply lost")
      if (text === "ROLLBACK") return new Promise(() => undefined)
      return { rows: [{ bytes: null }] }
    })
    const mirror = new PostgresAuthorityMirror(
      { query: active.query, connect: async () => active },
      "epoch-1",
      "supervisor-1"
    )
    await expect(mirror.readHead()).rejects.toThrow("commit reply lost")
    expect(active.release).toHaveBeenCalledWith(true)
    expect(active.query.mock.calls.flat()).not.toContain("ROLLBACK")
  })

  it("rejects absent response rows instead of treating them as an empty trusted mirror", async () => {
    const active = connection()
    active.query.mockResolvedValue({ rows: [] })
    const mirror = new PostgresAuthorityMirror(
      { query: active.query, connect: async () => active },
      "epoch-1",
      "supervisor-1"
    )
    await expect(mirror.readHead()).rejects.toThrow("invalid bytes")
    await expect(mirror.readRecord(1)).rejects.toThrow("invalid bytes")
  })

  it("discards a synchronously failing connection acquisition without leaking a timer", async () => {
    vi.useFakeTimers()
    const active = connection()
    const mirror = new PostgresAuthorityMirror(
      {
        query: active.query,
        connect: () => {
          throw new Error("offline")
        },
      },
      "epoch-1",
      "supervisor-1"
    )
    await expect(mirror.readHead()).rejects.toThrow("offline")
    expect(vi.getTimerCount()).toBe(0)
  })
})
