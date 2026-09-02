import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { authErrorResponse, withCookieMutation } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { requestFixPrApproval } from "@/lib/fix-pr"
import { FixPrContextError, resolveFixPrRequest } from "@/lib/fix-pr-context"

const CreatePRSchema = z.object({ workspaceId: z.string().min(1) }).strict()

/** Only the proposal id and workspace scope come from the client. */
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const parsed = CreatePRSchema.safeParse(await request.json())
    if (!parsed.success)
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    const { workspaceId } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.fix.createPr)
    const context = await resolveFixPrRequest(workspaceId, id, session.userId)
    const outcome = await requestFixPrApproval(context, env.NEXT_PUBLIC_APP_URL)
    if (outcome.status === "rejected")
      return apiError("PATCH_REJECTED", outcome.reason ?? "Patch failed validation", 422)
    return apiSuccess(outcome)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof FixPrContextError) return apiError(error.code, error.message, error.status)
    logger.error("Failed to validate fix PR request", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to validate fix proposal", 500)
  }
}

export const POST = withCookieMutation(post)
