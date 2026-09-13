import { NextResponse } from "next/server"
import { getApiRequestId } from "./api-auth"

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status })
}

export function apiError(
  code: string,
  message: string,
  status: number,
  /** Extra response headers — e.g. Retry-After on a 429 so clients back off correctly. */
  headers?: Record<string, string>,
  /** Structured extra data for the client to render actionable errors. */
  details?: unknown
) {
  // Correlate client-visible errors with server logs: the same id rides the
  // x-request-id response header (stamped by withApiRequest). The lookup is
  // best-effort — tests that subset-mock ./api-auth do not break apiError.
  let requestId: string | undefined
  try {
    requestId = getApiRequestId()
  } catch {
    /* subset logger/auth mocks */
  }
  return NextResponse.json(
    {
      success: false,
      error: {
        code,
        message,
        ...(requestId ? { requestId } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    },
    { status, headers }
  )
}

export function apiPaginated<T>(items: T[], nextCursor: string | null, total?: number) {
  return apiSuccess({ items, nextCursor, ...(total !== undefined ? { total } : {}) })
}

export function parsePaginationParams(searchParams: URLSearchParams, defaultLimit = 50) {
  const cursor = searchParams.get("cursor")
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? String(defaultLimit), 10) || defaultLimit, 1),
    100
  )
  return { cursor, limit }
}
