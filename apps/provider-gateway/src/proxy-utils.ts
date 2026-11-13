import { performance } from "node:perf_hooks"
import type { ProviderRoute } from "./config"
import { ProviderGatewayError } from "./errors"

export const MAX_DELIVERY_CHUNK_BYTES = 64 * 1024

export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  idleTimeoutMs?: number
): Promise<T> {
  if (signal.aborted) throw new Error("operation aborted")
  let onAbort: () => void = () => undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("operation aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    if (idleTimeoutMs !== undefined)
      timeout = setTimeout(
        () => reject(new Error("provider idle deadline exceeded")),
        idleTimeoutMs
      )
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  options: {
    signal: AbortSignal
    deadlineAt?: number
    idleTimeoutMs: number
    onChunk: (chunk: Uint8Array) => void | Promise<void>
  }
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  // Fixed storage also bounds object overhead for tiny fragmented inputs.
  const storage = Buffer.allocUnsafe(maxBytes)
  let total = 0
  try {
    for (;;) {
      if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt)
        throw new ProviderGatewayError(
          "PROVIDER_DEADLINE_EXCEEDED",
          "provider deadline exceeded",
          502
        )
      const { done, value } = await abortable(reader.read(), options.signal, options.idleTimeoutMs)
      if (done) break
      if (total + value.byteLength > maxBytes) {
        throw new ProviderGatewayError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "provider response exceeds the byte cap",
          502
        )
      }
      const start = total
      storage.set(value, start)
      total += value.byteLength
      for (let offset = 0; offset < value.byteLength; offset += MAX_DELIVERY_CHUNK_BYTES) {
        if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt)
          throw new ProviderGatewayError(
            "PROVIDER_DEADLINE_EXCEEDED",
            "provider deadline exceeded",
            502
          )
        const chunk = storage.subarray(
          start + offset,
          Math.min(total, start + offset + MAX_DELIVERY_CHUNK_BYTES)
        )
        await abortable(
          Promise.resolve(options.onChunk(chunk)),
          options.signal,
          options.idleTimeoutMs
        )
      }
    }
  } finally {
    // Do not await an uncooperative provider's cancellation acknowledgement.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return storage.subarray(0, total)
}

export function resolveProviderUrl(route: ProviderRoute, rawPath: string): URL {
  if (!rawPath.startsWith("/") || rawPath.includes("..") || rawPath.length > 4_096) {
    throw new ProviderGatewayError("INVALID_PROVIDER_PATH", "provider path is invalid", 400)
  }
  if (!route.allowedPathPrefixes.some((prefix) => rawPath.startsWith(prefix))) {
    throw new ProviderGatewayError("PROVIDER_PATH_DENIED", "provider path is not allowlisted")
  }
  const target = new URL(rawPath, route.baseUrl)
  const base = new URL(route.baseUrl)
  if (target.origin !== base.origin)
    throw new ProviderGatewayError("PROVIDER_PATH_DENIED", "provider path changed origin")
  return target
}

export function normalizeHeaderValue(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .slice(0, 1_024)
}
