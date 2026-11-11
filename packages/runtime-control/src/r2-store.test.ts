import { Readable } from "node:stream"
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it, vi } from "vitest"
import { R2ConditionalObjectStore } from "./r2-store"

async function bounded<T>(operation: Promise<T>): Promise<T | "not-aborted"> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"not-aborted">((resolve) => {
    timeout = setTimeout(() => resolve("not-aborted"), 1000)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe("R2 conditional authority storage", () => {
  it("writes create-once and compare-and-swap conditions without altering the ETag", async () => {
    const send = vi.fn(async (_command: unknown) => ({}))
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority"
    )
    await expect(
      store.put("epochs/epoch-2/head", Buffer.from("one"), { ifNoneMatch: true })
    ).resolves.toBe("written")
    await expect(
      store.put("epochs/epoch-2/head", Buffer.from("two"), { ifMatch: '"opaque-etag"' })
    ).resolves.toBe("written")
    const first = send.mock.calls[0]?.[0] as PutObjectCommand
    const second = send.mock.calls[1]?.[0] as PutObjectCommand
    expect(first.input).toMatchObject({
      Bucket: "private-authority",
      Key: "epochs/epoch-2/head",
      IfNoneMatch: "*",
    })
    expect(second.input.IfMatch).toBe('"opaque-etag"')
  })

  it("distinguishes explicit precondition failures from ambiguous errors", async () => {
    const send = vi.fn(async (_command: unknown): Promise<unknown> => {
      throw { $metadata: { httpStatusCode: 412 } }
    })
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority"
    )
    await expect(
      store.put("epochs/epoch-2/head", Buffer.from("one"), { ifNoneMatch: true })
    ).resolves.toBe("conflict")
    send.mockImplementationOnce(async () => {
      throw new Error("connection lost")
    })
    await expect(
      store.put("epochs/epoch-2/head", Buffer.from("one"), { ifNoneMatch: true })
    ).rejects.toThrow(/connection lost/)
  })

  it("treats only a real 404 as a negative read and caps streamed bytes", async () => {
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({
      ETag: '"etag"',
      ContentLength: 3,
      Body: Readable.from([Buffer.from("abc")]),
    }))
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority",
      4
    )
    const result = await store.read("epochs/epoch-2/head")
    expect(result?.etag).toBe('"etag"')
    expect(Buffer.from(result!.bytes).toString()).toBe("abc")
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand)
    send.mockImplementationOnce(async () => {
      throw { $metadata: { httpStatusCode: 404 } }
    })
    await expect(store.read("epochs/epoch-2/missing")).resolves.toBeNull()
    send.mockImplementationOnce(async () => ({
      ETag: '"etag"',
      ContentLength: 1,
      Body: Readable.from([Buffer.from("12345")]),
    }))
    await expect(store.read("epochs/epoch-2/large")).rejects.toThrow(/limit/)
  })

  it("rejects unsafe keys and invalid bucket configuration before contacting storage", async () => {
    const send = vi.fn(async (_command: unknown) => ({}))
    expect(
      () =>
        new R2ConditionalObjectStore({ send } as unknown as Pick<S3Client, "send">, "../invalid")
    ).toThrow()
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority"
    )
    await expect(store.read("epochs/../head")).rejects.toThrow(/key/)
    expect(send).not.toHaveBeenCalled()
  })

  it("aborts a response body that never finishes", async () => {
    const body = new Readable({ read() {} })
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({
      ETag: '"etag"',
      Body: body,
    }))
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority",
      1024,
      30
    )
    const pending = store.read("epochs/epoch-2/head").catch((error: unknown) => error)
    const result = await bounded(pending)
    body.destroy()
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/timed out/)
  })

  it("treats an unresponsive conditional write as ambiguous", async () => {
    const send = vi.fn((_command: unknown): Promise<unknown> => new Promise(() => undefined))
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority",
      1024,
      30
    )
    const pending = store
      .put("epochs/epoch-2/head", Buffer.from("one"), { ifNoneMatch: true })
      .catch((error: unknown) => error)
    const result = await bounded(pending)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/timed out/)
  })

  it.each(["*", '"old", "new"', 'W/"etag"', "unquoted"])(
    "rejects a non-exact ETag precondition %s",
    async (etag) => {
      const send = vi.fn(async (_command: unknown) => ({}))
      const store = new R2ConditionalObjectStore(
        { send } as unknown as Pick<S3Client, "send">,
        "private-authority"
      )
      await expect(
        store.put("epochs/epoch-2/head", Buffer.from("one"), { ifMatch: etag })
      ).rejects.toThrow(/conditional/)
      expect(send).not.toHaveBeenCalled()
    }
  )

  it("times out even if a response stream never completes destruction", async () => {
    const body = new Readable({ read() {}, destroy(_error, _callback) {} })
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({
      ETag: '"etag"',
      Body: body,
    }))
    const store = new R2ConditionalObjectStore(
      { send } as unknown as Pick<S3Client, "send">,
      "private-authority",
      1024,
      30
    )
    const result = await bounded(store.read("epochs/epoch-2/head").catch((error: unknown) => error))
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/timed out/)
  })
})
