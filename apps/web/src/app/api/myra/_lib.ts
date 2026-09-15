/**
 * Shared helpers for the /api/myra route family (docs/myra-spec.md).
 *
 * Two caller channels reach these routes:
 *  - anonymous marketing visitors carrying an `x-myra-session` public token
 *    (cross-origin CORS applies; ownership is enforced in the service layer);
 *  - authenticated dashboard users on their browser cookie session
 *    (same-origin mutation checks apply via withCookieMutation / the message
 *    route's explicit cookie check).
 *
 * Response shape is the structured `{ success, error: { code, message } }`
 * convention used across apps/web; error codes come from MYRA_ERROR_CODES so
 * the shared client can key on them.
 */
import { env } from "@lyrashield/config"
import {
  MYRA_ERROR_CODES,
  type MyraError,
  type MyraErrorCode,
  type MyraPrincipal,
  type MyraStreamEvent,
  type MyraSurface,
} from "@lyrashield/myra"
import { isPublicOriginAllowed, publicCorsHeaders } from "@/lib/public-cors"

/** Header carrying the anonymous public-session bearer token. */
export const MYRA_SESSION_HEADER = "x-myra-session"

// ─── Feature gates (default off; a disabled surface fails closed to 404) ─────

export function myraPublicEnabled(): boolean {
  return env.MYRA_PUBLIC_ENABLED === "1"
}

export function myraDashboardEnabled(): boolean {
  return env.MYRA_DASHBOARD_ENABLED === "1"
}

export function myraWritesEnabled(): boolean {
  return env.MYRA_WRITES_ENABLED === "1"
}

export function myraOperatorEnabled(): boolean {
  return env.MYRA_OPERATOR_ENABLED === "1"
}

/** Surface-level gate: MARKETING needs the public flag, DASHBOARD its own. */
export function myraSurfaceEnabled(surface: MyraSurface): boolean {
  return surface === "DASHBOARD" ? myraDashboardEnabled() : myraPublicEnabled()
}

/** Principal-level gate for routes without an explicit surface in the body. */
export function myraPrincipalEnabled(principal: MyraPrincipal): boolean {
  if (principal.kind === "user") return myraDashboardEnabled()
  if (principal.kind === "anonymous") return myraPublicEnabled()
  return myraOperatorEnabled()
}

// ─── Public CORS ────────────────────────────────────────────────────────────
// Mirrors lib/public-cors.ts but allows the x-myra-session header so the
// marketing site can send its public token cross-origin. Only the configured
// marketing/app origins ever receive CORS headers.

export function myraCorsHeaders(request: Request): Record<string, string> {
  const headers = publicCorsHeaders(request)
  if (!headers["Access-Control-Allow-Origin"]) return headers
  return {
    ...headers,
    "Access-Control-Allow-Headers": `Content-Type, ${MYRA_SESSION_HEADER}`,
  }
}

export function myraPreflight(request: Request): Response {
  if (!isPublicOriginAllowed(request)) {
    return myraFail(request, "FORBIDDEN", "Forbidden", 403)
  }
  return new Response(null, { status: 204, headers: myraCorsHeaders(request) })
}

// ─── Responses ──────────────────────────────────────────────────────────────

export function myraJson(
  request: Request,
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...myraCorsHeaders(request),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  })
}

export function myraOk(request: Request, data: unknown, status = 200): Response {
  return myraJson(request, { success: true, data }, status)
}

export function myraFail(
  request: Request,
  code: MyraErrorCode | string,
  message: string,
  status: number,
  extraHeaders?: Record<string, string>
): Response {
  return myraJson(request, { success: false, error: { code, message } }, status, extraHeaders)
}

/** Disabled surfaces do not reveal the feature exists. */
export function myraNotFound(request: Request): Response {
  return myraFail(request, "NOT_FOUND", "Not found", 404)
}

export function myraRateLimited(request: Request, retryAfter: number): Response {
  return myraFail(request, "RATE_LIMITED", "Too many requests", 429, {
    "Retry-After": String(Math.max(1, retryAfter)),
  })
}

// ─── Service error mapping ──────────────────────────────────────────────────

const MYRA_ERROR_STATUS: Record<MyraErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  // Disabled capabilities stay hidden behind 404.
  MYRA_DISABLED: 404,
  GENERATION_DISABLED: 404,
  WRITES_DISABLED: 404,
  BUDGET_EXHAUSTED: 429,
  PROVIDER_ERROR: 502,
  PROPOSAL_EXPIRED: 410,
  PROPOSAL_PAYLOAD_CHANGED: 409,
  PROPOSAL_STATE_INVALID: 409,
  OWNERSHIP_MISMATCH: 403,
  TAKEOVER_ACTIVE: 409,
  SLOT_UNAVAILABLE: 409,
  VERIFICATION_REQUIRED: 403,
  VERIFICATION_FAILED: 403,
  CALENDAR_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
}

const MYRA_ERROR_MESSAGES: Record<MyraErrorCode, string> = {
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "You do not have permission to perform this action",
  NOT_FOUND: "Not found",
  VALIDATION_ERROR: "Invalid request",
  RATE_LIMITED: "Too many requests",
  MYRA_DISABLED: "Myra is not available",
  GENERATION_DISABLED: "Myra is not available right now",
  WRITES_DISABLED: "That action is not available right now",
  BUDGET_EXHAUSTED: "Myra is unavailable right now",
  PROVIDER_ERROR: "A provider request failed",
  PROPOSAL_EXPIRED: "That confirmation expired — ask Myra again",
  PROPOSAL_PAYLOAD_CHANGED: "The confirmed details changed — review them again",
  PROPOSAL_STATE_INVALID: "That action is no longer valid",
  OWNERSHIP_MISMATCH: "That item does not belong to this session",
  TAKEOVER_ACTIVE: "A person is handling this conversation",
  SLOT_UNAVAILABLE: "That time is no longer available. Choose another slot.",
  VERIFICATION_REQUIRED: "Verification is required first",
  VERIFICATION_FAILED: "Verification failed",
  CALENDAR_NOT_CONFIGURED: "Booking is not configured",
  INTERNAL_ERROR: "Something went wrong",
}

const MYRA_ERROR_CODE_SET = new Set<string>(MYRA_ERROR_CODES)

function isMyraErrorCode(value: unknown): value is MyraErrorCode {
  return typeof value === "string" && MYRA_ERROR_CODE_SET.has(value)
}

/**
 * Extracts a structured Myra error from whatever the service layer threw.
 * Supports both `Error` objects whose `message` is the bare code (the
 * api-auth convention) and objects carrying a `code` field. Returns null for
 * unrecognized errors so callers can fall through to a generic 500.
 */
export function myraErrorFromUnknown(error: unknown): MyraError | null {
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  if (isMyraErrorCode(code)) {
    const message = (error as { message?: unknown }).message
    return {
      code,
      message:
        typeof message === "string" && message !== code && message.length > 0
          ? message.slice(0, 500)
          : MYRA_ERROR_MESSAGES[code],
    }
  }
  if (error instanceof Error && isMyraErrorCode(error.message)) {
    return { code: error.message, message: MYRA_ERROR_MESSAGES[error.message] }
  }
  return null
}

/** Structured response for a thrown service error, or null if unrecognized. */
export function myraServiceFailure(request: Request, error: unknown): Response | null {
  const mapped = myraErrorFromUnknown(error)
  if (!mapped) return null
  const status = MYRA_ERROR_STATUS[mapped.code]
  return myraFail(
    request,
    mapped.code,
    mapped.message,
    status,
    mapped.code === "RATE_LIMITED" || mapped.code === "BUDGET_EXHAUSTED"
      ? { "Retry-After": "60" }
      : undefined
  )
}

// ─── Rate-limit key ─────────────────────────────────────────────────────────

/**
 * Principal-stable rate-limit key. Anonymous sessions are bounded by their
 * publicSessionId; authenticated users and operators by their accountId.
 */
export function myraRateLimitKey(principal: MyraPrincipal): string {
  if (principal.kind === "anonymous") return `ps:${principal.publicSessionId}`
  return `acct:${principal.accountId}`
}

// ─── SSE ────────────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
} as const

function encodeEvent(event: MyraStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Pipes service stream events onto an SSE response, one
 * `data: <json>\n\n` frame per event. A thrown service error becomes a
 * terminal `error` event before the stream closes — never an unhandled
 * rejection mid-stream.
 */
export function myraSseResponse(
  request: Request,
  events: AsyncIterable<MyraStreamEvent>
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Keepalive comment every 15s — long model calls otherwise risk idle
      // cutoffs at intermediary proxies.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`))
        } catch {
          /* stream closed */
        }
      }, 15_000)
      try {
        for await (const event of events) {
          controller.enqueue(encodeEvent(event))
        }
      } catch (error) {
        const mapped = myraErrorFromUnknown(error) ?? {
          code: "INTERNAL_ERROR" as const,
          message: MYRA_ERROR_MESSAGES.INTERNAL_ERROR,
        }
        controller.enqueue(encodeEvent({ type: "error", error: mapped }))
      } finally {
        clearInterval(heartbeat)
        controller.close()
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, ...myraCorsHeaders(request) },
  })
}
