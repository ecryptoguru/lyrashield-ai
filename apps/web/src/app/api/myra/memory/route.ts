/** DELETE /api/myra/memory — clear the authenticated account's Myra memory. */
import { clearAccountMemory, resolveMyraRequest } from "@lyrashield/myra/server"
import { logger } from "@lyrashield/logger"
import { withCookieMutation } from "@/lib/api-auth"
import { myraDashboardEnabled, myraFail, myraNotFound, myraOk, myraServiceFailure } from "../_lib"

export const dynamic = "force-dynamic"

async function remove(request: Request): Promise<Response> {
  if (!myraDashboardEnabled()) return myraNotFound(request)
  const resolved = await resolveMyraRequest(request)
  if (!resolved || resolved.principal.kind !== "user") {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  try {
    return myraOk(request, await clearAccountMemory(resolved))
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra memory clear failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not clear memory", 500)
  }
}

export const DELETE = withCookieMutation(remove)
