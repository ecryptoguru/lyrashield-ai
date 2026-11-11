import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { Readable } from "node:stream"
import type { ConditionalObjectStore, StoredObject } from "./independent-journal"

const MAX_OBJECT_BYTES = 4 * 1024 * 1024
const EXACT_ETAG = /^"[A-Za-z0-9._:-]{1,200}"$/

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
export class R2ConditionalObjectStore implements ConditionalObjectStore {
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
    assertKey(key)
    const signal = AbortSignal.timeout(this.timeoutMs)
    let result
    try {
      result = await waitForAbort(
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        }),
        signal
      )
    } catch (error) {
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
          result.ContentLength > this.maxBytes))
    ) {
      body.destroy()
      throw new Error("authority object metadata exceeds its limit or lacks an ETag")
    }
    const chunks: Buffer[] = []
    let total = 0
    const abort = () => body.destroy(new Error("authority object read timed out"))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    try {
      const consume = async () => {
        for await (const chunk of body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += bytes.byteLength
          if (total > this.maxBytes) throw new Error("authority object exceeds its byte limit")
          chunks.push(bytes)
        }
      }
      await waitForAbort(consume(), signal)
    } catch (error) {
      body.destroy()
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
    if (result.ContentLength !== undefined && result.ContentLength !== total) {
      throw new Error("authority object content length does not match bytes read")
    }
    return { bytes: Buffer.concat(chunks, total), etag: result.ETag }
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
      return "written"
    } catch (error) {
      if (statusCode(error) === 412) return "conflict"
      throw error
    }
  }
}
