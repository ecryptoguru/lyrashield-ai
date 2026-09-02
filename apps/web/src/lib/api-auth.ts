import { NextResponse } from "next/server"
import { env } from "@lyrashield/config"

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
  return async (request, ...args) => {
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
  }
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
