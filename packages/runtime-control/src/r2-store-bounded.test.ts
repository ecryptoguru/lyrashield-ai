import { performance } from "node:perf_hooks"
import { Readable } from "node:stream"
import type { S3Client } from "@aws-sdk/client-s3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { R2ConditionalObjectStore } from "./r2-store"

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function client(send: (...args: unknown[]) => Promise<unknown>) {
  return { send } as unknown as Pick<S3Client, "send">
}
function iterableBody(values: AsyncGenerator<Uint8Array | string>) {
  const body = new Readable({ read() {} })
  vi.spyOn(body, Symbol.asyncIterator).mockImplementation(() => values)
  return body
}

describe("bounded R2 read transport", () => {
  it("uses a fixed caller-sized accumulator for 100,000 immediate fragments", async () => {
    const fragment = Buffer.from("x")
    const body = iterableBody(
      (async function* () {
        for (let i = 0; i < 100000; i++) yield fragment
      })()
    )
    const store = new R2ConditionalObjectStore(
      client(async () => ({ Body: body, ETag: '"opaque"' })),
      "private-authority"
    )
    const allocate = vi.spyOn(Buffer, "alloc"),
      concatenate = vi.spyOn(Buffer, "concat")
    const value = await store.readBounded("epochs/epoch-1/head", 100000)
    expect(allocate).toHaveBeenCalledExactlyOnceWith(100000)
    expect(concatenate).not.toHaveBeenCalled()
    expect(value?.bytes.byteLength).toBe(100000)
    expect(value?.bytes).toEqual(Buffer.alloc(100000, "x"))
    expect(value?.etag).toBe('"opaque"')
    body.destroy()
  })

  it("expires while immediate chunks starve the abort timer", async () => {
    const fragment = Buffer.from("x")
    let chunks = 0,
      signal: AbortSignal | undefined
    const body = iterableBody(
      (async function* () {
        for (; chunks < 100000; chunks++) yield fragment
      })()
    )
    const store = new R2ConditionalObjectStore(
      client(async (_command, options) => {
        signal = (options as { abortSignal: AbortSignal }).abortSignal
        return { Body: body, ETag: '"opaque"' }
      }),
      "private-authority",
      100000,
      5
    )
    await expect(store.readBounded("epochs/epoch-1/head", 100000)).rejects.toThrow("timed out")
    expect(chunks).toBeLessThan(100000)
    expect(signal?.aborted).toBe(false)
    expect(body.destroyed).toBe(true)
  })

  it("checks elapsed time before returning an empty successful body", async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    const body = iterableBody(
      (async function* () {
        now = 11
      })()
    )
    const store = new R2ConditionalObjectStore(
      client(async () => ({ Body: body, ETag: '"opaque"' })),
      "private-authority",
      100,
      10
    )
    await expect(store.readBounded("epochs/epoch-1/head", 10)).rejects.toThrow("timed out")
    expect(body.destroyed).toBe(true)
  })

  it("destroys an unread late body after an abort-ignoring header request times out", async () => {
    let resolve!: (value: unknown) => void
    const body = new Readable({ read() {} })
    const consume = vi.spyOn(body, Symbol.asyncIterator)
    const store = new R2ConditionalObjectStore(
      client(
        () =>
          new Promise((value) => {
            resolve = value
          })
      ),
      "private-authority",
      100,
      20
    )
    await expect(store.readBounded("epochs/epoch-1/head", 10)).rejects.toThrow("timed out")
    resolve({ Body: body, ETag: '"opaque"' })
    await Promise.resolve()
    await Promise.resolve()
    expect(body.destroyed).toBe(true)
    expect(consume).not.toHaveBeenCalled()
  })

  it("disposes headers accepted just before expiry when the awaiting read resumes too late", async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.spyOn(performance, "now").mockImplementation(() => [0, 9][calls++] ?? 11)
    const body = new Readable({ read() {} })
    const consume = vi.spyOn(body, Symbol.asyncIterator)
    const store = new R2ConditionalObjectStore(
      client(async () => ({ Body: body, ETag: '\"opaque\"' })),
      "private-authority",
      100,
      10
    )
    await expect(store.readBounded("epochs/epoch-1/head", 10)).rejects.toThrow("timed out")
    expect(body.destroyed).toBe(true)
    expect(consume).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, 4194305])(
    "rejects invalid caller limit %s before send",
    async (maxBytes) => {
      const send = vi.fn(async () => ({}))
      const store = new R2ConditionalObjectStore(client(send), "private-authority")
      await expect(store.readBounded("epochs/epoch-1/head", maxBytes)).rejects.toThrow("byte limit")
      expect(send).not.toHaveBeenCalled()
    }
  )

  it.each(["caller", "configured"])(
    "rejects oversized %s metadata without consuming its body",
    async (kind) => {
      const body = new Readable({ read() {} })
      const consume = vi.spyOn(body, Symbol.asyncIterator)
      const store = new R2ConditionalObjectStore(
        client(async () => ({ Body: body, ETag: '"opaque"', ContentLength: 11 })),
        "private-authority",
        kind === "configured" ? 10 : 100
      )
      await expect(
        store.readBounded("epochs/epoch-1/head", kind === "caller" ? 10 : 100)
      ).rejects.toThrow("metadata")
      expect(body.destroyed).toBe(true)
      expect(consume).not.toHaveBeenCalled()
    }
  )

  it.each(["oversize", "truncated", "etag"])("rejects %s response evidence", async (failure) => {
    const body = Readable.from([Buffer.from("abc")])
    const store = new R2ConditionalObjectStore(
      client(async () => ({
        Body: body,
        ETag: failure === "etag" ? 'W/"opaque"' : '"opaque"',
        ContentLength: failure === "truncated" ? 4 : undefined,
      })),
      "private-authority"
    )
    await expect(
      store.readBounded("epochs/epoch-1/head", failure === "oversize" ? 2 : 10)
    ).rejects.toThrow()
    expect(body.destroyed).toBe(true)
  })

  it("copies mixed UTF-8 and reused typed-array fragments without changing bytes", async () => {
    const fragment = new Uint8Array([97])
    const body = iterableBody(
      (async function* () {
        yield "é"
        yield fragment
        fragment[0] = 98
        yield fragment
      })()
    )
    const store = new R2ConditionalObjectStore(
      client(async () => ({ Body: body, ETag: '"opaque"', ContentLength: 4 })),
      "private-authority"
    )
    expect(Buffer.from((await store.readBounded("epochs/epoch-1/head", 4))!.bytes).toString()).toBe(
      "éab"
    )
    body.destroy()
  })

  it.each(["read", "write", "conflict"])(
    "keeps elapsed %s outcomes uncertain when timers cannot run",
    async (operation) => {
      vi.useFakeTimers()
      let now = 0
      vi.spyOn(performance, "now").mockImplementation(() => now)
      const store = new R2ConditionalObjectStore(
        client(async () => {
          now = 11
          if (operation === "write") return {}
          throw { $metadata: { httpStatusCode: operation === "read" ? 404 : 412 } }
        }),
        "private-authority",
        100,
        10
      )
      await expect(
        operation === "read"
          ? store.readBounded("epochs/epoch-1/head", 10)
          : store.put("epochs/epoch-1/head", Buffer.from("x"), { ifNoneMatch: true })
      ).rejects.toThrow("timed out")
    }
  )
})
