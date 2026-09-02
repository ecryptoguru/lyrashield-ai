import { prisma } from "@lyrashield/db"
import type { ScanMode } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { normalizeDomainForProof } from "@lyrashield/security"
import { CreateScanSchema, resolveScanProfile, resolveTargetScanMode } from "@lyrashield/types"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"
import {
  peekFreeUrlScanRateLimit,
  checkScanEligibilityRateLimit,
  clientIpFromRequest,
} from "../../../../lib/rate-limit"

const EligibilityQuerySchema = CreateScanSchema.pick({
  workspaceId: true,
  targetId: true,
  goal: true,
  mode: true,
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

    // The preflight runs on composer interaction, so it gets its own
    // (looser) per-workspace budget — but still a budget: it does real
    // entitlement reads per call and must not be unthrottled.
    const eligibilityRate = await checkScanEligibilityRateLimit(workspaceId)
    if (eligibilityRate.limited) {
      return apiError(
        "ELIGIBILITY_RATE_LIMITED",
        "Too many eligibility checks in the last minute. Please wait a moment.",
        429,
        { "Retry-After": String(Math.max(eligibilityRate.retryAfter, 1)) }
      )
    }

    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    // Mirror the POST-only gates that apply BEFORE entitlement evaluation, so
    // the preflight's verdict matches what the run submission would actually
    // hit. Both checks are read-only here (the free-URL limiter consumes a
    // token; that is the same meter POST uses, so a preflight does not let a
    // caller evade it — POST re-checks).
    if (target.type === "WEB_APP" || target.type === "API") {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      })
      if (!workspace || workspace.plan === "FREE") {
        // Read-only peek: repeated preflight calls must not consume the
        // caller's hourly free-URL budget. The POST path consumes the token.
        const freeUrlLimit = await peekFreeUrlScanRateLimit(clientIpFromRequest(request))
        if (freeUrlLimit.limited) {
          return eligibilityResponse({
            allowed: false,
            code: "FREE_URL_SCAN_RATE_LIMITED",
            message:
              "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews.",
            plan: "FREE",
            isTrial: false,
            remainingMinutes: 0,
          })
        }
      }
      if (workspace && workspace.plan !== "FREE") {
        const domain = target.url ? normalizeDomainForProof(target.url) : null
        const proof = domain
          ? await prisma.targetDomainVerification.findFirst({
              where: {
                workspaceId,
                domain,
                status: "VERIFIED",
                expiresAt: { gt: new Date() },
              },
              select: { id: true },
            })
          : null
        if (!proof) {
          return eligibilityResponse({
            allowed: false,
            code: "DOMAIN_VERIFICATION_REQUIRED",
            message: "Verify control of this domain once before starting a paid remote review.",
            plan: workspace.plan,
            isTrial: false,
            remainingMinutes: 0,
          })
        }
      }
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

    let canonicalMode: ScanMode = mode
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
    const entitlement = await evaluateScanEntitlement(workspaceId, canonicalMode, {
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
