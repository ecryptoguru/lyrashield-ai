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
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)

  const onParentAbort = () => controller.abort()
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
      if (!timedOut) throw new ApiError("ABORTED", "Request was cancelled", 0)
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

interface ConditionalResponse<T> {
  data: T | null
  etag: string | undefined
  status: number
}

export async function apiGetConditional<T>(
  url: string,
  options: FetchOptions & { etag?: string } = {}
): Promise<ConditionalResponse<T>> {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeout ?? DEFAULT_TIMEOUT_MS)

  const headers = new Headers(options.headers)
  if (options.etag) {
    headers.set("If-None-Match", options.etag)
  }

  try {
    const res = await fetch(url, {
      ...options,
      method: "GET",
      headers,
      signal: controller.signal,
    })

    const etag = res.headers.get("ETag") ?? undefined

    if (res.status === 304) {
      return { data: null, etag, status: 304 }
    }

    if (!res.ok) {
      throw new ApiError("HTTP_ERROR", `Request failed with status ${res.status}`, res.status)
    }

    const json = (await res.json()) as ApiResponse<T>
    if (!json.success) {
      throw new ApiError(
        json.error?.code ?? "UNKNOWN_ERROR",
        json.error?.message ?? "An unknown error occurred",
        res.status
      )
    }

    return { data: json.data as T, etag, status: res.status }
  } catch (err) {
    if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
      if (!timedOut) throw new ApiError("ABORTED", "Request was cancelled", 0)
      throw new ApiError(
        "TIMEOUT",
        `Request timed out after ${options.timeout ?? DEFAULT_TIMEOUT_MS}ms`,
        0
      )
    }
    if (err instanceof ApiError) throw err
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
  } finally {
    clearTimeout(timeoutId)
  }
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

/**
 * Paginated GET with ETag revalidation. Used by polling surfaces: pass the ETag
 * from the previous tick and a 304 comes back with `data: null`, so an unchanged
 * list costs no response body and no JSON parse.
 */
export async function apiGetPaginatedConditional<T>(
  url: string,
  params?: Record<string, string | undefined>,
  options: FetchOptions & { etag?: string } = {}
): Promise<ConditionalResponse<PaginatedResponse<T>>> {
  const searchParams = new URLSearchParams()
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, value)
      }
    }
  }
  const fullUrl = searchParams.toString() ? `${url}?${searchParams}` : url

  return apiGetConditional<PaginatedResponse<T>>(fullUrl, options)
}
