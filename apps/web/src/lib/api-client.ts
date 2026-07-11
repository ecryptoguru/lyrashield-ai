import type { ApiResponse, PaginatedResponse } from "@lyrashield/types"

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message)
    this.name = "ApiError"
  }
}

interface FetchOptions extends RequestInit {
  /** Parse the response as JSON and return `data` on success, throw on failure. */
  parseJson?: boolean
  /** Request timeout in milliseconds. Defaults to 30 seconds. */
  timeout?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

async function request<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { parseJson = true, timeout = DEFAULT_TIMEOUT_MS, ...init } = options

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  const onParentAbort = () => controller.abort()
  if (init.signal) {
    init.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError("TIMEOUT", `Request timed out after ${timeout}ms`, 0)
    }
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
  } finally {
    clearTimeout(timeoutId)
    if (init.signal) {
      init.signal.removeEventListener("abort", onParentAbort)
    }
  }

  if (!parseJson) {
    if (!res.ok) {
      throw new ApiError("HTTP_ERROR", `Request failed with status ${res.status}`, res.status)
    }
    return undefined as T
  }

  let json: ApiResponse<T>
  try {
    json = await res.json()
  } catch {
    throw new ApiError("PARSE_ERROR", `Failed to parse response (status ${res.status})`, res.status)
  }

  if (!json.success) {
    const code = json.error?.code ?? "UNKNOWN_ERROR"
    const message = json.error?.message ?? "An unknown error occurred"
    throw new ApiError(code, message, res.status)
  }

  return json.data as T
}

export async function apiGet<T>(url: string, options?: FetchOptions): Promise<T> {
  return request<T>(url, { ...options, method: "GET" })
}

export async function apiPost<T>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiPatch<T>(url: string, body?: unknown, options?: FetchOptions): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiDelete<T>(url: string, options?: FetchOptions): Promise<T> {
  return request<T>(url, { ...options, method: "DELETE" })
}

/**
 * Fetch a paginated list endpoint. Returns items + nextCursor.
 * Pass `cursor` to load the next page.
 */
export async function apiGetPaginated<T>(
  url: string,
  params?: Record<string, string | undefined>,
  options?: FetchOptions
): Promise<PaginatedResponse<T>> {
  const searchParams = new URLSearchParams()
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, value)
      }
    }
  }
  const fullUrl = searchParams.toString() ? `${url}?${searchParams}` : url

  return request<PaginatedResponse<T>>(fullUrl, { ...options, method: "GET" })
}
