/**
 * GET /api/myra/operator/operations — stuck confirmed-action ledger view.
 *
 * Spec §9: reconciliation must be able to finish or safely surface
 * already-started operations, and operators get a view of stuck actions.
 * "Stuck" = EXECUTING / OUTCOME_UNKNOWN at any age, or AWAITING_CONFIRMATION
 * past its expiry. Read-only; same operator boundary as the inbox.
 *
 * The payload column is deliberately NOT selected: it holds the exact
 * confirmed input and this triage view only needs lifecycle metadata.
 */
import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { withMyraOperatorRLS } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withApiRequest } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { myraOperatorEnabled, myraOperatorPrivate } from "../../_lib"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 100

async function get(request: Request): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return myraOperatorPrivate(apiError("NOT_FOUND", "Not found", 404))
  }
  let operatorId: string
  try {
    const operator = await requirePlatformAdminIdentity()
    operatorId = operator.userId
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) return myraOperatorPrivate(authError)
    return myraOperatorPrivate(apiError("FORBIDDEN", "Forbidden", 403))
  }

  const { searchParams } = new URL(request.url)
  const cursor = searchParams.get("cursor")

  try {
    const now = new Date()
    // Operator-bound trusted path: the platform-admin check above is the
    // authorization, the binding declares it to the dual-owner tables'
    // RESTRICTIVE boundary (v18 1.3).
    const items = await withMyraOperatorRLS(operatorId, (tx) =>
      tx.myraOperation.findMany({
        where: {
          OR: [
            { status: { in: ["EXECUTING", "OUTCOME_UNKNOWN"] } },
            { status: "AWAITING_CONFIRMATION", expiresAt: { lt: now } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          operationName: true,
          status: true,
          accountId: true,
          publicSessionId: true,
          workspaceId: true,
          conversationId: true,
          idempotencyKey: true,
          expiresAt: true,
          executedAt: true,
          error: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    )
    const nextCursor = items.length > PAGE_SIZE ? items[PAGE_SIZE]!.id : null
    return myraOperatorPrivate(
      apiSuccess({
        items: items.slice(0, PAGE_SIZE),
        nextCursor,
      })
    )
  } catch (error) {
    logger.error("Myra operator stuck-operations list failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(
      apiError("INTERNAL_ERROR", "Could not load the operations list", 500)
    )
  }
}

export const GET = withApiRequest(get)
