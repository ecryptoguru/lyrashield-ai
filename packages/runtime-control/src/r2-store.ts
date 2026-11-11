import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { Readable } from "node:stream"
import { performance } from "node:perf_hooks"
import type { BoundedConditionalObjectStore, StoredObject } from "./independent-journal"

const MAX_OBJECT_BYTES = 4 * 1024 * 1024
const EXACT_ETAG = /^"[A-Za-z0-9._:-]{1,200}"$/

function assertDeadline(signal: AbortSignal, expiresAt: number): void {
  if (signal.aborted || performance.now() >= expiresAt)
    throw new Error("authority storage request timed out")
}

function disposeBody(body: unknown): void {
  if (body instanceof Readable) {
    body.once("error", () => undefined)
    body.destroy()
  }
}

function statusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined
  const metadata = Reflect.get(error, "$metadata")
  if (metadata === null || typeof metadata !== "object") return undefined
  const value = Reflect.get(metadata, "httpStatusCode")
  return typeof value === "number" ? value : undefined
}

function assertKey(key: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/.test(key) ||
    key.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("invalid authority object key")
  }
}

async function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    throw new Error("authority storage request timed out")
  }
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("authority storage request timed out"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * R2's S3 conditional writes serialize create-once and ETag-based head updates.
 * A null read is only a 404 observation, never proof that an earlier ambiguous
 * write failed. The journal protocol must replay that same operation identity.
 * The caller owns the client and must isolate its credentials from workers.
 */
export class R2ConditionalObjectStore implements BoundedConditionalObjectStore {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly bucket: string,
    private readonly maxBytes = MAX_OBJECT_BYTES,
    private readonly timeoutMs = 10_000
  ) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("invalid private authority bucket name")
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OBJECT_BYTES) {
      throw new Error("invalid authority object byte limit")
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("invalid authority object timeout")
    }
  }

  async read(key: string): Promise<StoredObject | null> {
    return this.readBounded(key, this.maxBytes)
  }

  async readBounded(key: string, maxBytes: number): Promise<StoredObject | null> {
    assertKey(key)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OBJECT_BYTES)
      throw new Error("invalid authority object read byte limit")
    const limit = Math.min(maxBytes, this.maxBytes)
    const expiresAt = performance.now() + this.timeoutMs
    const signal = AbortSignal.timeout(this.timeoutMs)
    let discarded = false
    const pending = this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: signal,
    })
    // A transport that ignores abort may return headers later. Discard its body
    // without consuming it; timing out never proves a previous write failed.
    void pending
      .then(
        (value) => {
          if (discarded || signal.aborted || performance.now() >= expiresAt) disposeBody(value.Body)
        },
        () => undefined
      )
      .catch(() => undefined)
    let result
    try {
      result = await waitForAbort(pending, signal)
      assertDeadline(signal, expiresAt)
    } catch (error) {
      discarded = true
      if (result) disposeBody(result.Body)
      assertDeadline(signal, expiresAt)
      if (statusCode(error) === 404) return null
      throw error
    }
    const body = result.Body
    if (!(body instanceof Readable))
      throw new Error("authority object body is not a readable stream")
    if (
      !result.ETag ||
      !EXACT_ETAG.test(result.ETag) ||
      (result.ContentLength !== undefined &&
        (!Number.isSafeInteger(result.ContentLength) ||
          result.ContentLength < 0 ||
          result.ContentLength > limit))
    ) {
      body.destroy()
      throw new Error("authority object metadata exceeds its limit or lacks an ETag")
    }
    const bytes = Buffer.alloc(result.ContentLength ?? limit)
    let total = 0
    const abort = () => body.destroy(new Error("authority object read timed out"))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    try {
      const consume = async () => {
        for await (const chunk of body) {
          assertDeadline(signal, expiresAt)
          if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
            throw new Error("authority object contains an invalid chunk")
          const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
          if (length > limit - total) throw new Error("authority object exceeds its byte limit")
          if (length > bytes.byteLength - total)
            throw new Error("authority object content length does not match bytes read")
          if (typeof chunk === "string") bytes.write(chunk, total, length)
          else bytes.set(chunk, total)
          total += length
          assertDeadline(signal, expiresAt)
        }
        assertDeadline(signal, expiresAt)
      }
      await waitForAbort(consume(), signal)
      if (result.ContentLength !== undefined && result.ContentLength !== total) {
        throw new Error("authority object content length does not match bytes read")
      }
      assertDeadline(signal, expiresAt)
      return { bytes: bytes.subarray(0, total), etag: result.ETag }
    } catch (error) {
      body.destroy()
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ): Promise<"written" | "conflict"> {
    assertKey(key)
    if (bytes.byteLength > this.maxBytes) throw new Error("authority object exceeds its byte limit")
    const ifNoneMatch = "ifNoneMatch" in condition && condition.ifNoneMatch === true
    const ifMatch = "ifMatch" in condition ? condition.ifMatch : undefined
    if (
      Object.keys(condition).length !== 1 ||
      (ifNoneMatch && ifMatch !== undefined) ||
      (!ifNoneMatch && (typeof ifMatch !== "string" || !EXACT_ETAG.test(ifMatch)))
    ) {
      throw new Error("invalid authority conditional write")
    }
    const expiresAt = performance.now() + this.timeoutMs
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      await waitForAbort(
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.from(bytes),
            ContentType: "application/json",
            ...(ifNoneMatch ? { IfNoneMatch: "*" } : { IfMatch: ifMatch }),
          }),
          { abortSignal: signal }
        ),
        signal
      )
      assertDeadline(signal, expiresAt)
      return "written"
    } catch (error) {
      assertDeadline(signal, expiresAt)
      if (statusCode(error) === 412) return "conflict"
      throw error
    }
  }
}
