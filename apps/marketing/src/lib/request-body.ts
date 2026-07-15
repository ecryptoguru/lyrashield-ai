export const MAX_WAITLIST_BODY_BYTES = 16_384

export class RequestBodyError extends Error {
  constructor(
    readonly status: 413 | 415,
    readonly code: "payload_too_large" | "unsupported_media_type",
    message: string
  ) {
    super(message)
    this.name = "RequestBodyError"
  }
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyError(413, "payload_too_large", "Request body is too large.")
  }

  if (!request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let body = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new RequestBodyError(413, "payload_too_large", "Request body is too large.")
    }
    body += decoder.decode(value, { stream: true })
  }

  return body + decoder.decode()
}

export async function parseBoundedBody(
  request: Request,
  maxBytes = MAX_WAITLIST_BODY_BYTES
): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get("content-type") || "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase()

  if (
    contentType &&
    contentType !== "application/json" &&
    contentType !== "application/x-www-form-urlencoded"
  ) {
    throw new RequestBodyError(415, "unsupported_media_type", "Use JSON or URL-encoded form data.")
  }

  const raw = await readBoundedText(request, maxBytes)
  if (contentType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  return Object.fromEntries(new URLSearchParams(raw))
}
