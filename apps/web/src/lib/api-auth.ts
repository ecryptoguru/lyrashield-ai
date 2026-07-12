import { NextResponse } from "next/server"

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
  }
  return null
}
