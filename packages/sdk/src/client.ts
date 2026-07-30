import { LyraShieldError, NotModified } from "./errors"

export const VERSION = "0.1.0"

const DEFAULT_API_URL = "https://app.lyrashieldai.com"
const REQUEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 3

export interface LyraShieldClientOptions {
  apiKey: string
  apiUrl?: string
  fetchFn?: typeof fetch
  workspaceId?: string
  userAgent?: string
}

export interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
  etag?: string
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"])

export class LyraShieldClient {
  readonly apiKey: string
  readonly apiUrl: string
  readonly fetchFn: typeof fetch
  readonly workspaceId?: string
  readonly userAgent: string

  constructor(options: LyraShieldClientOptions) {
    this.apiKey = options.apiKey
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "")
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.workspaceId = options.workspaceId
    this.userAgent = options.userAgent ?? `lyrashield-sdk/${VERSION}`
  }

  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T | NotModified>
  async request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions
  ): Promise<T | NotModified> {
    const url = this.buildUrl(path)
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
    const body = options?.body != null ? JSON.stringify(options.body) : undefined

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
    }
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`
    if (body) headers["Content-Type"] = "application/json"
    if (options?.etag) headers["If-None-Match"] = options.etag
    if (options?.headers) Object.assign(headers, options.headers)

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const res = await this.fetchFn(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (res.status === 304) {
          const etag = this.getHeader(res, "etag") ?? options?.etag ?? undefined
          return new NotModified(etag)
        }

        if ((res.status === 429 || res.status === 503) && isIdempotent && attempt < MAX_RETRIES - 1) {
          const retryAfterHeader = this.getHeader(res, "retry-after")
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN
          const baseDelay = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 2 ** attempt * 500
          const jitter = Math.random() * 500
          const delay = Math.min(baseDelay + jitter, 30000)
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }

        if (!res.ok) {
          const { message, code } = await this.parseErrorBody(res)
          throw new LyraShieldError({
            status: res.status,
            code,
            message,
            retryAfter: this.parseRetryAfter(res),
          })
        }

        const json = await this.parseJson(res)
        if (json === undefined || json === null) {
          return undefined as T
        }

        const envelope = json as {
          success?: unknown
          data?: unknown
          error?: { code?: string; message?: string }
        }
        if (envelope.success !== true) {
          throw new LyraShieldError({
            status: res.status,
            code: envelope.error?.code,
            message: envelope.error?.message ?? "API call failed",
            retryAfter: this.parseRetryAfter(res),
          })
        }

        return envelope.data as T
      } catch (err) {
        clearTimeout(timeout)
        if (err instanceof LyraShieldError) throw err
        if (err instanceof Error && err.name === "AbortError") {
          throw new LyraShieldError({ status: 0, code: "REQUEST_TIMEOUT", message: "Request timed out" })
        }
        throw err
      }
    }

    throw new LyraShieldError({ status: 0, code: "MAX_RETRIES_EXCEEDED", message: "Max retries exceeded" })
  }

  private buildUrl(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`
    return `${this.apiUrl}/api/v1${normalized}`
  }

  private getHeader(res: Response, name: string): string | null {
    const headers = res.headers as unknown as
      | Headers
      | { get?: (name: string) => string | null }
      | Record<string, string>
      | undefined
    if (!headers) return null
    if (headers instanceof Headers) return headers.get(name)
    if ("get" in headers && typeof (headers as { get?: unknown }).get === "function") {
      return (headers as { get: (name: string) => string | null }).get(name)
    }
    const record = headers as Record<string, string>
    return record[name] ?? record[name.toLowerCase()] ?? null
  }

  private async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch {
      return undefined
    }
  }

  private async parseErrorBody(res: Response): Promise<{ message: string; code?: string }> {
    let message = `${res.status} ${res.statusText ?? ""}`.trim()
    let code: string | undefined
    try {
      const json = (await res.json()) as { error?: { code?: string; message?: string } } | undefined
      if (json?.error?.message) message = json.error.message
      if (json?.error?.code) code = json.error.code
    } catch {
      // fall through
    }
    return { message, code }
  }

  private parseRetryAfter(res: Response): number | undefined {
    const header = this.getHeader(res, "retry-after")
    if (!header) return undefined
    const seconds = Number(header)
    return Number.isFinite(seconds) ? seconds : undefined
  }
}
