import type { ProviderRoute } from "./config"
import { ProviderGatewayError } from "./errors"

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("operation aborted")
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("operation aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ProviderGatewayError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "provider response exceeds the byte cap",
          502
        )
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
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
