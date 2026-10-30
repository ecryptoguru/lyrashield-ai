import { createHash } from "node:crypto"
import { safeFetchOnce } from "@lyrashield/security/safe-fetch"

export const GO_RESOLVER_LIMITS = {
  milliseconds: 90_000,
  modules: 500,
  bytes: 50 * 1024 * 1024,
} as const
export const GO_PROXY_ORIGIN = "https://proxy.golang.org"
export interface GoMetadataReceipt {
  path: string
  sha256: string
  bytes: number
}
export function validGoMetadataPath(path: string): boolean {
  if (path.length > 1024 || path.includes("..") || path.includes("//")) return false
  const [modulePath, suffix, extra] = path.split("/@v/")
  return (
    !extra &&
    !!modulePath &&
    modulePath.includes(".") &&
    modulePath.split("/").every((segment) => /^[a-z0-9!][a-z0-9!._-]*$/.test(segment)) &&
    !!suffix &&
    /^v\d+\.\d+\.\d+[A-Za-z0-9.+!-]*\.(?:mod|info)$/.test(suffix)
  )
}
export function missingGoMetadataPaths(stderr: string): string[] {
  return [
    ...new Set(
      [...stderr.matchAll(/file:\/\/\/proxy\/([^\s:]+):/g)]
        .map((match) => match[1]!)
        .filter(validGoMetadataPath)
    ),
  ]
}
/** A file-backed metadata relay, never a proxy accessible to repository processes.
 * The sandbox has no network. Every request is GET to this exact origin; redirects
 * are refused. safeFetchOnce validates DNS and pins each TLS connection's address.
 */
export class GoMetadataBroker {
  readonly receipts: GoMetadataReceipt[] = []
  private readonly cached = new Map<string, string>()
  private readonly modules = new Set<string>()
  private bytes = 0
  constructor(
    private readonly deadline: number,
    private readonly signal?: AbortSignal,
    private readonly fetchMetadata: typeof safeFetchOnce = safeFetchOnce,
    private readonly limits: { modules: number; bytes: number } = GO_RESOLVER_LIMITS
  ) {}
  async get(path: string): Promise<string> {
    if (!validGoMetadataPath(path)) throw new Error("Unsupported Go metadata request")
    const remaining = this.deadline - Date.now()
    if (remaining <= 0 || this.signal?.aborted)
      throw new Error("Go resolution deadline or cancellation")
    const cached = this.cached.get(path)
    if (cached !== undefined) return cached
    const modulePath = path.split("/@v/")[0]!
    this.modules.add(modulePath)
    // Bound requests as well as distinct modules (many versions of one module).
    if (
      this.modules.size > this.limits.modules ||
      this.receipts.length >= GO_RESOLVER_LIMITS.modules * 4 ||
      this.bytes >= this.limits.bytes
    )
      throw new Error("Go metadata budget exhausted")
    const result = await this.fetchMetadata(`${GO_PROXY_ORIGIN}/${path}`, {
      timeoutMs: Math.min(15_000, remaining),
      maxRedirects: 0,
      maxBytes: Math.min(512 * 1024, this.limits.bytes - this.bytes),
      signal: this.signal,
      accept: "text/plain, application/json",
    })
    if (!result.ok) throw new Error("Go public metadata unavailable")
    this.bytes += result.result.bodyBytes
    if (
      this.bytes > this.limits.bytes ||
      result.result.bodyTruncated ||
      result.result.status !== 200 ||
      Date.now() >= this.deadline
    )
      throw new Error("Go metadata rejected or bounded")
    const content = result.result.html
    // Check bytes independently of injected transport metadata.
    if (Buffer.byteLength(content) > this.limits.bytes || Buffer.byteLength(content) > 512 * 1024)
      throw new Error("Go metadata exceeds byte limit")
    this.receipts.push({
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })
    this.cached.set(path, content)
    return content
  }
}
