import { withCookieMutation } from "../../../../lib/api-auth"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { resolveAccountBilling } from "@lyrashield/billing"
import { withAccountRLS } from "@lyrashield/db"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"

const SpendLimitSchema = z.object({
  cents: z.number().int().min(0).max(10_000_000), // max $100,000 in cents
})

/**
 * POST /api/billing/spend-limit — set the overage spend limit on the CALLER's
 * account subscription (account-owned billing).
 *
 * Only accounts on the Launch Assurance plan can set a spend limit. The limit
 * controls how much overage (at $0.15/min) the account may consume beyond its
 * included minutes, across every workspace it scans in.
 *
 * All money is in integer cents (Decimal-safe, never Float).
 */
async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = SpendLimitSchema.safeParse(body)
  if (!parsed.success) {
    // A-L09: Don't leak Zod error details to clients
    logger.warn("Spend limit validation error", { errors: parsed.error.issues })
    return apiError("VALIDATION_ERROR", "Invalid request body", 400)
  }

  const { cents } = parsed.data

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requirePermission(workspaceId, PERMISSIONS.billing.manage)
    const accountId = session.userId

    // The spend limit lives on the account's governing subscription row.
    const billingAccount = await resolveAccountBilling(accountId)

    if (!billingAccount || billingAccount.effectivePlan !== "LAUNCH_ASSURANCE") {
      return apiError(
        "PLAN_NOT_ELIGIBLE",
        "Spend limits are only available on the Launch Assurance plan.",
        403
      )
    }

    await withAccountRLS(accountId, (tx) =>
      tx.billingAccount.update({
        where: { id: billingAccount.id },
        data: { spendLimitCents: cents },
      })
    )

    // Audit log — attributed to the workspace the action was taken from.
    await prisma.auditLog.create({
      data: {
        workspaceId,
        action: "billing.spend_limit_updated",
        resourceType: "billing_account",
        resourceId: billingAccount.id,
        metadata: { spendLimitCents: cents, accountId },
      },
    })

    logger.info("Spend limit updated", { accountId, workspaceId, cents })

    return apiSuccess({ cents }, 200)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Spend limit update failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update spend limit", 500)
  }
}

export const POST = withCookieMutation(post)
