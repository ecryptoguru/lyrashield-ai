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
import { myraOperatorEnabled, myraOperatorPrivate } from "../../_lib"

export const dynamic = "force-dynamic"

const listQuerySchema = z
  .object({
    status: z.enum(SUPPORT_CASE_STATUSES).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict()

async function get(request: Request): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return myraOperatorPrivate(apiError("NOT_FOUND", "Not found", 404))
  }
  let operator: Awaited<ReturnType<typeof requirePlatformAdminIdentity>>
  try {
    operator = await requirePlatformAdminIdentity()
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) return myraOperatorPrivate(authError)
    return myraOperatorPrivate(apiError("FORBIDDEN", "Forbidden", 403))
  }

  const { searchParams } = new URL(request.url)
  const parsed = listQuerySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
  })
  if (!parsed.success) {
    return myraOperatorPrivate(apiError("VALIDATION_ERROR", "Invalid query", 400))
  }

  try {
    const result = await listOperatorCases(
      {
        status: parsed.data.status,
        cursor: parsed.data.cursor,
      },
      operator.userId
    )
    return myraOperatorPrivate(apiSuccess(result))
  } catch (error) {
    logger.error("Myra operator case list failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(apiError("INTERNAL_ERROR", "Could not load cases", 500))
  }
}

export const GET = withApiRequest(get)
