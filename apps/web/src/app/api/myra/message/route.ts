/**
 * POST /api/myra/message — one chat turn, streamed as SSE.
 *
 * Frames are `data: <json>\n\n` where each payload is a MyraStreamEvent from
 * the shared contracts; the service's async generator is piped through and a
 * thrown error becomes a terminal `error` event before close.
 *
 * Auth: resolveMyraRequest handles both channels — anonymous public sessions
 * (`x-myra-session`, exempt from origin checks because they carry no cookies)
 * and browser cookie sessions (same-origin enforced via the explicit cookie
 * check below). Callers must hit /api/myra/session first; nothing here mints
 * credentials.
 */
import { handleMessage, resolveMyraRequest } from "@lyrashield/myra/server"
import { postMessageRequestSchema } from "@lyrashield/myra"
import { assertSameOriginMutation, withApiRequest } from "@/lib/api-auth"
import { checkMyraRateLimit } from "@/lib/rate-limit"
import {
  myraDashboardEnabled,
  myraFail,
  myraNotFound,
  myraPreflight,
  myraPublicEnabled,
  myraRateLimitKey,
  myraRateLimited,
  myraSseResponse,
  myraSurfaceEnabled,
} from "../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = postMessageRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  // CSRF: anonymous public sessions carry no cookies and are exempt; a request
  // that DOES carry cookies is a browser-session mutation and must be
  // same-origin.
  if (request.headers.has("cookie")) {
    try {
      assertSameOriginMutation(request)
    } catch {
      return myraFail(request, "FORBIDDEN", "Forbidden", 403)
    }
  }

  if (!myraSurfaceEnabled(parsed.data.surface)) return myraNotFound(request)

  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Start a Myra session before sending messages", 401)
  }

  // Principal-level gates sit alongside the surface gate so a forged surface
  // value never widens a caller into a disabled channel.
  if (resolved.principal.kind === "anonymous" && !myraPublicEnabled()) {
    return myraNotFound(request)
  }
  if (resolved.principal.kind === "user" && !myraDashboardEnabled()) {
    return myraNotFound(request)
  }
  if (resolved.principal.kind === "operator") {
    return myraFail(request, "FORBIDDEN", "Forbidden", 403)
  }

  const limit = await checkMyraRateLimit("message", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  // MYRA_GENERATION_ENABLED is enforced inside handleMessage (the service
  // emits a GENERATION_DISABLED error event); the route passes through so
  // retrieval/handoff stays available during a generation outage.
  const events = handleMessage(resolved, {
    text: parsed.data.text,
    conversationId: parsed.data.conversationId,
    routeContext: parsed.data.routeContext,
    surface: parsed.data.surface,
  })
  return myraSseResponse(request, events)
}

export const POST = withApiRequest(post)
