import { createHash } from "crypto"
import { NextResponse } from "next/server"

/**
 * Strong ETag for a JSON-serializable representation (W2.4). Hashes the exact
 * value the response carries, so a 304 is only served when the client already
 * holds this representation — a changed body always changes the tag.
 */
export function representationEtag(body: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`
}

/**
 * RFC 9110 conditional-GET check. Honors `If-None-Match` as an exact tag, a
 * comma-separated tag list, or `*`. Returns a bodyless 304 echoing the ETag,
 * or null when the request must be answered in full.
 */
export function notModifiedResponse(request: Request, etag: string): Response | null {
  const header = request.headers.get("if-none-match")
  if (!header) return null
  if (header.trim() === "*") {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  const tags = header.split(",").map((tag) => tag.trim())
  if (tags.includes(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  return null
}

/**
 * `{ success: true, data }` JSON body carrying a representation ETag, or a 304
 * when the request's `If-None-Match` already names it (W2.4).
 */
export function jsonWithEtag(
  request: Request,
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  const etag = representationEtag(data)
  const notModified = notModifiedResponse(request, etag)
  if (notModified) return notModified
  return NextResponse.json(
    { success: true, data },
    { status: init?.status ?? 200, headers: { ETag: etag, ...init?.headers } }
  )
}
