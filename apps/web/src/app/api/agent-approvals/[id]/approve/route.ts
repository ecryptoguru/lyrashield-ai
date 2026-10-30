import { withCookieMutation } from "../../../../../lib/api-auth"
import {
  ApprovalMutationError,
  approveApproval,
  getApproval,
  verifyInputHash,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { FixPrContextError, resolveFixPrRequest } from "@/lib/fix-pr-context"
import { z } from "zod"
import { buildFixPrApprovalInput, executeApprovedFixPr } from "@/lib/fix-pr"

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: approvalId } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = z
    .object({ workspaceId: z.string().min(1), input: z.record(z.string(), z.unknown()) })
    .strict()
    .safeParse(body)
  if (!parsed.success)
    return apiError("VALIDATION_ERROR", "Expected workspaceId and input only", 400)
  const { workspaceId, input } = parsed.data

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.agent.approve)

    const approval = await getApproval(approvalId, workspaceId)
    if (!approval) {
      return apiError("NOT_FOUND", "Approval not found", 404)
    }

    if (!verifyInputHash(approval.actionName, input, approval.inputHash)) {
      return apiError(
        "INPUT_HASH_MISMATCH",
        "Submitted input does not match the requested action",
        422
      )
    }

    // Fix PR execution is authorized separately and reconstructed exclusively
    // from the stored proposal. The execution claim rechecks the exact hash.
    let fixContext
    if (approval.actionName === "fix_pr.open") {
      await requirePermission(workspaceId, PERMISSIONS.fix.approve)
      const stored = approval.input as Record<string, unknown> | null
      if (!stored || typeof stored.fixProposalId !== "string") {
        return apiError("INVALID_FIX_APPROVAL", "Approval has no stored fix proposal", 409)
      }
      fixContext = await resolveFixPrRequest(workspaceId, stored.fixProposalId, session.userId)
      if (
        !verifyInputHash(
          approval.actionName,
          buildFixPrApprovalInput(fixContext),
          approval.inputHash
        )
      ) {
        return apiError(
          "INPUT_HASH_MISMATCH",
          "The stored patch changed. Request a new approval.",
          422
        )
      }
    }
    const updated = await approveApproval(approvalId, workspaceId, session.userId)
    if (fixContext) {
      const execution = await executeApprovedFixPr({ ...fixContext, approvalId })
      if (execution.status !== "opened") {
        return apiError(
          "FIX_PR_NOT_OPENED",
          "The pull request could not be opened. Review the approval state before retrying.",
          409
        )
      }
      return apiSuccess({ ...updated, execution })
    }
    return apiSuccess(updated)
  } catch (err) {
    if (err instanceof FixPrContextError) return apiError(err.code, err.message, err.status)
    if (err instanceof ApprovalMutationError && err.code === "NOT_FOUND") {
      return apiError("NOT_FOUND", err.message, 404)
    }
    if (err instanceof ApprovalMutationError) {
      return apiError("CONFLICT", err.message, 409)
    }
    const authErr = authErrorResponse(err)
    if (authErr) return authErr
    // Fallback for non-auth errors — authErrorResponse returns null otherwise,
    // which is not a valid Response. (Q7)
    logger.error("Failed to approve agent action", { error: String(err) })
    return apiError("INTERNAL_ERROR", "Failed to approve agent action", 500)
  }
}

export const POST = withCookieMutation(post)
