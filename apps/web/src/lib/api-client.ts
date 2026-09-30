import { z } from "zod"
import type { ApiResponse, PaginatedResponse } from "@lyrashield/types"
import { safeApiErrorMessage } from "./safe-api-error-message"

export class ApiError extends Error {
  details?: unknown

  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(safeApiErrorMessage(message))
    this.name = "ApiError"
  }
}

interface FetchOptions<T = unknown> extends RequestInit {
  /** Parse the response as JSON and return `data` on success, throw on failure. */
  parseJson?: boolean
  /** Request timeout in milliseconds. Defaults to 30 seconds. */
  timeout?: number
  /** Optional Zod schema to validate the response `data` instead of casting it. */
  schema?: z.ZodType<T>
}

const DEFAULT_TIMEOUT_MS = 30_000

const apiResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

function httpError(status: number): ApiError {
  return new ApiError("HTTP_ERROR", `Request failed with status ${status}`, status)
}

function responseError(json: ApiResponse<unknown>, status: number): ApiError {
  const error = new ApiError(
    json.error?.code ?? "UNKNOWN_ERROR",
    json.error?.message ?? "An unknown error occurred",
    status
  )
  error.details = json.error?.details
  return error
}

async function readApiResponse(response: Response): Promise<ApiResponse<unknown>> {
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (!response.ok) throw httpError(response.status)
    throw new ApiError(
      "PARSE_ERROR",
      `Failed to parse response (status ${response.status})`,
      response.status
    )
  }

  const parsed = apiResponseSchema.safeParse(body)
  if (!parsed.success) {
    if (!response.ok) throw httpError(response.status)
    throw new ApiError(
      "PARSE_ERROR",
      `Invalid response envelope (status ${response.status})`,
      response.status
    )
  }
  return parsed.data as ApiResponse<unknown>
}

function appendQueryParams(url: string, params?: Record<string, string | undefined>): string {
  if (!params) return url

  const hashIndex = url.indexOf("#")
  const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex)
  const queryIndex = urlWithoutHash.indexOf("?")
  const path = queryIndex === -1 ? urlWithoutHash : urlWithoutHash.slice(0, queryIndex)
  const searchParams = new URLSearchParams(
    queryIndex === -1 ? "" : urlWithoutHash.slice(queryIndex + 1)
  )

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, value)
  }

  const query = searchParams.toString()
  return `${path}${query ? `?${query}` : ""}${hash}`
}

function jsonHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  if (!result.has("Content-Type")) result.set("Content-Type", "application/json")
  return result
}

function parseWithSchema<T>(data: unknown, schema: z.ZodType<T>, status: number): T {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ApiError(
        "VALIDATION_ERROR",
        `Response validation failed: ${err.issues.map((issue) => issue.message).join(", ")}`,
        status
      )
    }
    throw err
  }
}

async function request<T>(url: string, options: FetchOptions<T> = {}): Promise<T> {
  const { parseJson = true, timeout = DEFAULT_TIMEOUT_MS, schema, ...init } = options

  const controller = new AbortController()
  let timedOut = false
  const requestTimeoutMs = timeout
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, requestTimeoutMs)

  const onParentAbort = () => controller.abort()
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal })

    if (!parseJson) {
      if (!res.ok) {
        throw new ApiError("HTTP_ERROR", `Request failed with status ${res.status}`, res.status)
      }
      return undefined as T
    }

    const json = await readApiResponse(res)

    if (!res.ok) {
      if (!json.success) throw responseError(json, res.status)
      throw httpError(res.status)
    }

    if (!json.success) {
      throw responseError(json, res.status)
    }

    if (schema) {
      return parseWithSchema(json.data, schema, res.status)
    }

    return json.data as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
      if (!timedOut) throw new ApiError("ABORTED", "Request was cancelled", 0)
      throw new ApiError("TIMEOUT", `Request timed out after ${requestTimeoutMs}ms`, 0)
    }
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
  } finally {
    clearTimeout(timeoutId)
    init.signal?.removeEventListener("abort", onParentAbort)
  }
}

export async function apiGet<T>(url: string, options?: FetchOptions<T>): Promise<T> {
  return request<T>(url, { ...options, method: "GET" })
}

interface ConditionalResponse<T> {
  data: T | null
  etag: string | undefined
  status: number
}

export async function apiGetConditional<T>(
  url: string,
  options: FetchOptions<T> & { etag?: string } = {}
): Promise<ConditionalResponse<T>> {
  const { schema, ...fetchOptions } = options
  const controller = new AbortController()
  let timedOut = false
  const conditionalTimeoutMs = fetchOptions.timeout ?? DEFAULT_TIMEOUT_MS
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, conditionalTimeoutMs)

  // This function owns `signal` (it needs its own for the timeout), so the
  // caller's signal must be forwarded explicitly — otherwise it is silently
  // dropped by the spread below and a polling effect's cleanup cannot cancel an
  // in-flight request, which then runs until the timeout fires.
  const onCallerAbort = () => controller.abort()
  if (fetchOptions.signal) {
    if (fetchOptions.signal.aborted) controller.abort()
    else fetchOptions.signal.addEventListener("abort", onCallerAbort, { once: true })
  }

  const headers = new Headers(fetchOptions.headers)
  if (options.etag) {
    headers.set("If-None-Match", options.etag)
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      method: "GET",
      headers,
      signal: controller.signal,
    })

    const etag = res.headers.get("ETag") ?? undefined

    if (res.status === 304) {
      return { data: null, etag, status: 304 }
    }

    const json = await readApiResponse(res)
    if (!res.ok) {
      if (!json.success) throw responseError(json, res.status)
      throw httpError(res.status)
    }
    if (!json.success) {
      throw responseError(json, res.status)
    }

    return {
      data: schema ? parseWithSchema(json.data, schema, res.status) : (json.data as T),
      etag,
      status: res.status,
    }
  } catch (err) {
    if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
      if (!timedOut) throw new ApiError("ABORTED", "Request was cancelled", 0)
      throw new ApiError("TIMEOUT", `Request timed out after ${conditionalTimeoutMs}ms`, 0)
    }
    if (err instanceof ApiError) throw err
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
  } finally {
    clearTimeout(timeoutId)
    fetchOptions.signal?.removeEventListener("abort", onCallerAbort)
  }
}

export async function apiPost<T>(
  url: string,
  body?: unknown,
  options?: FetchOptions<T>
): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "POST",
    headers: jsonHeaders(options?.headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiPatch<T>(
  url: string,
  body?: unknown,
  options?: FetchOptions<T>
): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "PATCH",
    headers: jsonHeaders(options?.headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiPut<T>(
  url: string,
  body?: unknown,
  options?: FetchOptions<T>
): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "PUT",
    headers: jsonHeaders(options?.headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiDelete<T>(url: string, options?: FetchOptions<T>): Promise<T> {
  return request<T>(url, { ...options, method: "DELETE" })
}

/**
 * Fetch a paginated list endpoint. Returns items + nextCursor.
 * Pass `cursor` to load the next page.
 */
export async function apiGetPaginated<T>(
  url: string,
  params?: Record<string, string | undefined>,
  options?: FetchOptions<PaginatedResponse<T>>
): Promise<PaginatedResponse<T>> {
  const fullUrl = appendQueryParams(url, params)
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
  options: FetchOptions<PaginatedResponse<T>> & { etag?: string } = {}
): Promise<ConditionalResponse<PaginatedResponse<T>>> {
  const fullUrl = appendQueryParams(url, params)
  return apiGetConditional<PaginatedResponse<T>>(fullUrl, options)
}
