import { createApproval, listApprovals } from "@lyrashield/db"
import { checkApprovalCreateRateLimit } from "../../../lib/rate-limit"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import {
  apiError,
  apiPaginated,
  apiSuccess,
  parsePaginationParams,
} from "../../../lib/api-response"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  if (!workspaceId) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }

  const status = url.searchParams.get("status") ?? undefined
  if (status && !["PENDING", "APPROVED", "DENIED", "EXPIRED"].includes(status)) {
    return apiError("VALIDATION_ERROR", "Invalid status filter", 400)
  }

  try {
    await requirePermission(workspaceId, PERMISSIONS.agent.view)
    const { cursor, limit } = parsePaginationParams(url.searchParams)
    const result = await listApprovals({
      workspaceId,
      ...(status ? { status: status as "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })
    return apiPaginated(result.items, result.nextCursor)
  } catch (err) {
    const authErr = authErrorResponse(err)
    if (authErr) return authErr
    // Fallback for non-auth errors — previously this returned null. (Q7)
    logger.error("Failed to list agent approvals", { error: String(err) })
    return apiError("INTERNAL_ERROR", "Failed to list agent approvals", 500)
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const typed = body as {
    workspaceId?: string
    actionName?: string
    input?: Record<string, unknown>
    expiresAt?: string
  }
  if (!typed.workspaceId || !typed.actionName) {
    return apiError("VALIDATION_ERROR", "workspaceId and actionName are required", 400)
  }
  if (!typed.input || typeof typed.input !== "object" || Array.isArray(typed.input)) {
    return apiError("VALIDATION_ERROR", "input is required and must be an object", 400)
  }

  try {
    const { session } = await requirePermission(typed.workspaceId, PERMISSIONS.agent.act)
    const rate = await checkApprovalCreateRateLimit(typed.workspaceId)
    if (rate.limited) {
      return apiError("RATE_LIMITED", "Approval creation rate limit exceeded", 429)
    }
    const expiresAt = typed.expiresAt
      ? new Date(typed.expiresAt)
      : new Date(Date.now() + 15 * 60 * 1000)
    const approval = await createApproval({
      workspaceId: typed.workspaceId,
      actionName: typed.actionName,
      input: typed.input,
      requestedById: session.userId,
      expiresAt,
    })
    return apiSuccess(approval, 201)
  } catch (err) {
    const authErr = authErrorResponse(err)
    if (authErr) return authErr
    logger.error("Failed to create agent approval", { error: String(err) })
    return apiError("INTERNAL_ERROR", "Failed to create agent approval", 500)
  }
}
