import type { ApiResponse, PaginatedResponse } from "@lyrashield/types"

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

interface FetchOptions extends RequestInit {
  /** Parse the response as JSON and return `data` on success, throw on failure. */
  parseJson?: boolean
}

async function request<T>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const { parseJson = true, ...init } = options
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
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

  if (!json.success || json.data === undefined) {
    const code = json.error?.code ?? "UNKNOWN_ERROR"
    const message = json.error?.message ?? "An unknown error occurred"
    throw new ApiError(code, message, res.status)
  }

  return json.data
}

export async function apiGet<T>(url: string, options?: FetchOptions): Promise<T> {
  return request<T>(url, { ...options, method: "GET" })
}

export async function apiPost<T>(
  url: string,
  body?: unknown,
  options?: FetchOptions,
): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function apiPatch<T>(
  url: string,
  body?: unknown,
  options?: FetchOptions,
): Promise<T> {
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
  options?: FetchOptions,
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

  let res: Response
  try {
    res = await fetch(fullUrl, { ...options, method: "GET" })
  } catch {
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0)
  }

  let json: ApiResponse<T[]> & { nextCursor?: string | null; total?: number }
  try {
    json = await res.json()
  } catch {
    throw new ApiError("PARSE_ERROR", `Failed to parse response (status ${res.status})`, res.status)
  }

  if (!json.success || json.data === undefined) {
    throw new ApiError(
      json.error?.code ?? "UNKNOWN_ERROR",
      json.error?.message ?? "An unknown error occurred",
      res.status,
    )
  }

  return {
    items: json.data,
    nextCursor: json.nextCursor ?? null,
    total: json.total,
  }
}
