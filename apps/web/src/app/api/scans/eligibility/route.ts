import { prisma } from "@lyrashield/db"
import type { ScanMode } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { resolveScanProfile, resolveTargetScanMode } from "@lyrashield/types"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { z } from "zod"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"

const EligibilityQuerySchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  goal: z.string().min(1).max(64),
  mode: z.string().min(1).max(32),
})

/**
 * Eligibility payloads are workspace-sensitive (plan, remaining minutes), so
 * the response is always private and never stored by shared caches.
 */
function eligibilityResponse(data: unknown, status = 200) {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { "Cache-Control": "private, no-store" } }
  )
}

/**
 * Read-only Trust Run eligibility preflight.
 *
 * Advisory: the composer calls this so Start can be disabled with a reason
 * before submission, but POST /api/scans repeats the authoritative check
 * immediately before creation — a preflight pass never replaces the mutation
 * gate. This endpoint performs no trial, billing, scan, or audit mutation and
 * returns no monetary amount, model identifier, or upstream-engine detail.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const parsed = EligibilityQuerySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }
    const { workspaceId, targetId, mode } = parsed.data
    // `goal` is part of the validated contract (and the composer's identity
    // for a review) but does not change eligibility on its own.
    void parsed.data.goal

    // Same workspace permission and target ownership checks as scan creation.
    await requirePermission(workspaceId, PERMISSIONS.scan.create)

    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    // Resolve the canonical review profile exactly as POST does, so the
    // preflight judges the review the run would actually perform.
    if (target.type === "WEB_APP" || target.type === "API") {
      const resolved = resolveTargetScanMode({
        targetType: target.type,
        mode,
        hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
      })
      if (!resolved.ok) {
        return eligibilityResponse({
          allowed: false,
          code: resolved.code,
          message: resolved.reason,
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
    }

    let canonicalMode = mode
    if (target.type === "REPO" || target.type === "WEB_APP" || target.type === "API") {
      try {
        canonicalMode = resolveScanProfile({
          targetType: target.type,
          mode,
        }).canonicalMode
      } catch (error) {
        const code = error instanceof Error ? error.message : "TARGET_TYPE_UNSUPPORTED"
        return eligibilityResponse({
          allowed: false,
          code,
          message: "This review type is not available for the selected target.",
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
    } else if (target.type) {
      return eligibilityResponse({
        allowed: false,
        code: "TARGET_TYPE_UNSUPPORTED",
        message: "This target cannot be reviewed yet.",
        plan: "UNKNOWN",
        isTrial: false,
        remainingMinutes: 0,
      })
    }

    // Read-only entitlement evaluation: no trial/billing mutation on GET.
    // canonicalMode is a resolved profile mode at this point — every
    // unsupported combination returned above.
    const entitlement = await evaluateScanEntitlement(workspaceId, canonicalMode as ScanMode, {
      mutateOnTrialExpiry: false,
    })

    logger.info("Scan eligibility preflight", {
      workspaceId,
      targetId,
      allowed: entitlement.allowed,
      code: entitlement.code ?? null,
    })

    return eligibilityResponse({
      allowed: entitlement.allowed,
      code: entitlement.allowed ? null : (entitlement.code ?? "SCAN_NOT_ALLOWED"),
      message: entitlement.allowed ? null : (entitlement.message ?? "Scan not allowed"),
      plan: entitlement.plan,
      isTrial: entitlement.isTrial,
      remainingMinutes: entitlement.remainingMinutes,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to evaluate scan eligibility", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to evaluate scan eligibility", 500)
  }
}
