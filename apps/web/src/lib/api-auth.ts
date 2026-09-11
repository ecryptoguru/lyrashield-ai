import { NextResponse } from "next/server"
import { env } from "@lyrashield/config"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { setRequestIdResolver } from "@lyrashield/logger"

/**
 * Request id for log correlation, scoped with AsyncLocalStorage so concurrent
 * requests never observe each other's id (Node.js runtime only — API route
 * handlers run in Node, not the edge middleware). `withApiRequest` runs the
 * handler under a fresh id (honouring an upstream `x-request-id` when present)
 * and the logger's resolver reads it back from the async context, so every
 * line — including Prisma slow-query warnings — carries the caller's id even
 * while another request is in flight.
 */
const apiRequestStorage = new AsyncLocalStorage<{ requestId: string }>()

// The logger is runtime-agnostic; bind its stamp to this app's async context
// once, at module scope. Where no request is in flight the resolver returns
// undefined and the logger falls back to the legacy module variable (worker
// and edge callers still use setRequestId directly). Many unit tests mock
// @lyrashield/logger with a subset of exports; accessing the missing export
// throws under vitest's proxy, so bind best-effort.
try {
  setRequestIdResolver(() => apiRequestStorage.getStore()?.requestId)
} catch {
  /* subset logger mocks do not expose setRequestIdResolver */
}

export function getApiRequestId(): string | undefined {
  return apiRequestStorage.getStore()?.requestId
}

export function withApiRequest<Req extends Request, Args extends unknown[], Result>(
  handler: (request: Req, ...args: Args) => Promise<Result>
): (request: Req, ...args: Args) => Promise<Result> {
  return async (request, ...args) => {
    const upstreamId = request.headers.get("x-request-id")?.slice(0, 128)
    const requestId = upstreamId && /^[\w-]+$/.test(upstreamId) ? upstreamId : randomUUID()
    return apiRequestStorage.run({ requestId }, () => handler(request, ...args))
  }
}

/** Browser mutations must originate from the configured application origin. */
export function assertSameOriginMutation(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  // Explicit contradictory browser metadata always fails closed.
  if (site && site !== "same-origin") throw new Error("FORBIDDEN")
  if (origin) {
    if (origin !== new URL(env.NEXT_PUBLIC_APP_URL).origin) throw new Error("FORBIDDEN")
  } else if (site !== "same-origin") {
    throw new Error("FORBIDDEN")
  }
}

/** Keep method detection at the route boundary; headers() has no HTTP method. */
export function withCookieMutation<
  Req extends Request,
  Args extends unknown[],
  Result extends Response,
>(
  handler: (request: Req, ...args: Args) => Promise<Result>
): (request: Req, ...args: Args) => Promise<Result | NextResponse> {
  return withApiRequest(async (request, ...args) => {
    if (request.headers.has("cookie")) {
      const { getSession } = await import("@lyrashield/auth/server")
      const session = await getSession()
      // Session resolution is cookie-first. A forged Bearer header never exempts it.
      if (session && !session.apiKey && !session.oauth) {
        try {
          assertSameOriginMutation(request)
        } catch (error) {
          const response = authErrorResponse(error)
          if (response) return response
          throw error
        }
      }
    }
    return handler(request, ...args)
  })
}

/**
 * Maps errors thrown by the auth helpers (`requireAuth` / `requireWorkspaceAccess` /
 * `requirePermission`) to standard API error responses.
 *
 * Returns `null` when `error` is not a recognized auth error, so callers can fall
 * through to their generic 500 handler:
 *
 *   } catch (error) {
 *     const authErr = authErrorResponse(error)
 *     if (authErr) return authErr
 *     logger.error(...)
 *     return NextResponse.json({ ...INTERNAL_ERROR }, { status: 500 })
 *   }
 */
export function authErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof Error) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to perform this action",
          },
        },
        { status: 403 }
      )
    }
    if (error.message === "ADMIN_REAUTH_REQUIRED") {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "ADMIN_REAUTH_REQUIRED",
            message: "Administrator verification is required",
          },
        },
        { status: 401 }
      )
    }
  }
  return null
}
