import { NextResponse } from "next/server"

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status })
}

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

export function apiPaginated<T>(items: T[], nextCursor: string | null, total?: number) {
  return apiSuccess({ items, nextCursor, ...(total !== undefined ? { total } : {}) })
}

export function parsePaginationParams(searchParams: URLSearchParams) {
  const cursor = searchParams.get("cursor")
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100)
  return { cursor, limit }
}
