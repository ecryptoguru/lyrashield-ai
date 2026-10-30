import { z } from "zod"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { authErrorResponse, withCookieMutation } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { getFixPrStatus, requestFixPrApproval } from "@/lib/fix-pr"
import { FixPrContextError, resolveFixPrRequest } from "@/lib/fix-pr-context"
import { recordedOperation } from "@/lib/recorded-operation"
import { diffChecksum } from "@lyrashield/fix"

const CreatePRSchema = z.object({ workspaceId: z.string().min(1) }).strict()

/** Only the proposal id and workspace scope come from the client. */
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
    }
    const parsed = CreatePRSchema.safeParse(body)
    if (!parsed.success)
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    const { workspaceId } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.fix.createPr)
    if (session.apiKey || session.oauth?.connectionId) {
      await requirePermission(workspaceId, PERMISSIONS.fix.approve)
    }
    const context = await resolveFixPrRequest(workspaceId, id, session.userId)
    assertOAuthDelegatedScope(session, context.targetId)
    const authorization = session.oauth?.connectionId
      ? { kind: "oauth-connection" as const, id: session.oauth.connectionId }
      : session.apiKey
        ? { kind: "api-key" as const, id: session.apiKey.keyId }
        : undefined
    return await recordedOperation(
      request,
      {
        workspaceId,
        operationName: "fix.pr.request",
        input: {
          proposalId: id,
          targetId: context.targetId,
          baseCommit: context.baseCommit,
          diffChecksum: diffChecksum(context.diff),
        },
        session,
      },
      async ({ confirmNotSubmitted }) => {
        const outcome = await requestFixPrApproval(
          { ...context, authorization },
          env.NEXT_PUBLIC_APP_URL
        )
        if (outcome.status === "rejected") {
          confirmNotSubmitted()
          return apiError("PATCH_REJECTED", outcome.reason ?? "Patch failed validation", 422)
        }
        if (outcome.status === "failed") {
          return apiError(
            "FIX_PR_FAILED",
            "Fix PR execution did not complete. Inspect the operation status before retrying.",
            502
          )
        }
        return apiSuccess(outcome)
      }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof FixPrContextError) return apiError(error.code, error.message, error.status)
    logger.error("Failed to validate fix PR request", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to validate fix proposal", 500)
  }
}

export const POST = withCookieMutation(post)

/** Read-only GitHub reconciliation; does not authorize or repeat repository writes. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const parsed = z
      .object({ workspaceId: z.string().min(1), approvalId: z.string().min(1).optional() })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) return apiError("INVALID_PARAM", "Invalid status query", 400)
    const { workspaceId, approvalId } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.fix.createPr)
    const context = await resolveFixPrRequest(workspaceId, (await params).id, session.userId)
    assertOAuthDelegatedScope(session, context.targetId)
    return apiSuccess(await getFixPrStatus(context, approvalId))
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof FixPrContextError) return apiError(error.code, error.message, error.status)
    logger.error("Failed to read fix PR status", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Unable to check pull request status", 500)
  }
}
