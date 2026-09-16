/**
 * GET /api/myra/operator/cases — founder support inbox listing.
 *
 * Cross-workspace operator access: allowlisted PLATFORM_OPERATOR browser
 * session with a TOTP stamp inside the 12h read window (spec §6). Bearer
 * credentials and workspace roles never grant this boundary.
 */
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { listOperatorCases } from "@lyrashield/myra/server"
import { SUPPORT_CASE_STATUSES } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse, withApiRequest } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { myraOperatorEnabled } from "../../_lib"

export const dynamic = "force-dynamic"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

const listQuerySchema = z
  .object({
    status: z.enum(SUPPORT_CASE_STATUSES).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict()

async function get(request: Request): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return apiError("NOT_FOUND", "Not found", 404, PRIVATE_HEADERS)
  }
  let operator: Awaited<ReturnType<typeof requirePlatformAdminIdentity>>
  try {
    operator = await requirePlatformAdminIdentity()
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        authError.headers.set(name, value)
      return authError
    }
    return apiError("FORBIDDEN", "Forbidden", 403, PRIVATE_HEADERS)
  }

  const { searchParams } = new URL(request.url)
  const parsed = listQuerySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
  })
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Invalid query", 400, PRIVATE_HEADERS)
  }

  try {
    const result = await listOperatorCases(
      {
        status: parsed.data.status,
        cursor: parsed.data.cursor,
      },
      operator.userId
    )
    const response = apiSuccess(result)
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    logger.error("Myra operator case list failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return apiError("INTERNAL_ERROR", "Could not load cases", 500, PRIVATE_HEADERS)
  }
}

export const GET = withApiRequest(get)
