import {
  prisma,
  resolveScanAttachments,
  resolveAuthenticatedAssessmentAuthorization,
  LiveAiSafetyError,
  ScanAttachmentError,
} from "@lyrashield/db"
import type { ScanMode } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { normalizeDomainForProof } from "@lyrashield/security"
import { CreateScanInputSchema, resolveScanProfile, resolveTargetScanMode } from "@lyrashield/types"
import { env, evaluateAuthAssessmentAdmission } from "@lyrashield/config"
import {
  evaluateScanEntitlement,
  isTrialAvailable,
  resolveAccountBilling,
  resolveWorkspaceScanSponsor,
} from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"
import {
  peekFreeUrlScanRateLimit,
  checkScanEligibilityRateLimit,
  clientIpFromRequest,
} from "../../../../lib/rate-limit"

const ELIGIBILITY_QUERY_KEYS = new Set([
  "workspaceId",
  "targetId",
  "goal",
  "mode",
  "workflow",
  "baseRef",
  "headRef",
  "attachmentId",
  "authorizationRef",
])

/**
 * Eligibility payloads are workspace-sensitive (plan, remaining minutes), so
 * the response is always private and never stored by shared caches.
 */
function eligibilityResponse(data: unknown, status = 200) {
  return NextResponse.json(
    {
      success: true,
      data: {
        version: "lyrashield-scan-eligibility/1.0.0",
        advisory: true,
        notEvaluated: ["futureCapacity", "workerAvailability", "sourceRevision"],
        ...(data as Record<string, unknown>),
      },
    },
    { status, headers: { "Cache-Control": "private, no-store" } }
  )
}

/**
 * Read-only scan eligibility preflight.
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
    if (
      [...searchParams.keys()].some(
        (key) =>
          !ELIGIBILITY_QUERY_KEYS.has(key) ||
          (key !== "attachmentId" && searchParams.getAll(key).length > 1)
      )
    ) {
      return apiError("INVALID_PARAM", "Unknown or repeated query parameter", 400)
    }
    const attachmentIds = searchParams.getAll("attachmentId")
    const parsed = CreateScanInputSchema.safeParse({
      ...Object.fromEntries(searchParams),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })
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
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)

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

    assertOAuthDelegatedScope(session, targetId, mode)

    if (attachmentIds.length > 0) {
      try {
        await resolveScanAttachments(workspaceId, [...new Set(attachmentIds)])
      } catch (error) {
        if (error instanceof ScanAttachmentError) {
          return eligibilityResponse({
            allowed: false,
            code: error.code,
            message: error.message,
            plan: "UNKNOWN",
            isTrial: false,
            remainingMinutes: 0,
          })
        }
        throw error
      }
    }

    if (parsed.data.workflow === "REVIEW_CHANGES") {
      if (target.type !== "REPO") {
        return eligibilityResponse({
          allowed: false,
          code: "SCAN_PLAN_INVALID",
          message: "Review Changes requires a repository target.",
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
      if (
        !target.installationId ||
        !(target.repoOwner ?? target.repoFullName?.split("/")[0]) ||
        !(target.repoName ?? target.repoFullName?.split("/")[1])
      ) {
        return eligibilityResponse({
          allowed: false,
          code: "SCAN_SOURCE_UNAVAILABLE",
          message: "Review Changes requires a repository connected through the GitHub App.",
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
    }

    if (parsed.data.workflow === "AUTHENTICATED_ASSESSMENT") {
      const betaAdmission = evaluateAuthAssessmentAdmission({
        enabled: env.LYRASHIELD_AUTH_ASSESSMENT_ENABLED === "1",
        allowlist: env.LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST,
        workspaceId,
        targetId,
      })
      if (!betaAdmission.allowed || (target.type !== "WEB_APP" && target.type !== "API")) {
        return eligibilityResponse({
          allowed: false,
          code: betaAdmission.allowed ? "SCAN_PLAN_INVALID" : "SCAN_WORKFLOW_UNAVAILABLE",
          message: betaAdmission.allowed
            ? "Authenticated assessment requires a live web app or API target."
            : "Authenticated assessment is not enabled for this workspace and target.",
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
      const policy = await prisma.policy.findFirst({
        where: { workspaceId, name: "Default Policy", deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { destructiveTestsAllowed: true },
      })
      if (policy?.destructiveTestsAllowed) {
        return eligibilityResponse({
          allowed: false,
          code: "SCAN_PLAN_DENIED",
          message:
            "The selected policy allows destructive tests, which the authenticated assessment forbids.",
          plan: "UNKNOWN",
          isTrial: false,
          remainingMinutes: 0,
        })
      }
      try {
        await resolveAuthenticatedAssessmentAuthorization({
          workspaceId,
          targetId,
          authorizationRef: parsed.data.authorizationRef!,
        })
      } catch (error) {
        if (error instanceof LiveAiSafetyError) {
          return eligibilityResponse({
            allowed: false,
            code: error.code,
            message: "The recorded assessment authorization does not cover this target.",
            plan: "UNKNOWN",
            isTrial: false,
            remainingMinutes: 0,
          })
        }
        throw error
      }
    }

    // Resolve the canonical review profile exactly as POST does, so the
    // preflight judges the review the run would actually perform — including
    // whether the tier is engine-backed (which decides the consent gates).
    let urlEngineBacked = false
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
      urlEngineBacked =
        resolved.profile !== null && resolveScanProfile({ targetType: target.type, mode }).usesAi
    }

    // Mirror the POST-only gates that apply BEFORE entitlement evaluation, so
    // the preflight's verdict matches what the run submission would actually
    // hit. Both checks are read-only here (the free-URL limiter consumes a
    // token; that is the same meter POST uses, so a preflight does not let a
    // caller evade it — POST re-checks). Domain verification is required only
    // for engine-backed tiers; the deterministic tier needs no proof.
    if (target.type === "WEB_APP" || target.type === "API") {
      // The sponsor's effective plan decides — workspace.plan is a display
      // field under account-owned billing.
      const sponsor = await resolveWorkspaceScanSponsor(workspaceId, session.userId)
      const sponsorBilling = sponsor?.agencyActive
        ? null
        : await resolveAccountBilling(session.userId)
      const sponsorPlan = sponsor?.agencyActive
        ? "LAUNCH_ASSURANCE"
        : (sponsorBilling?.effectivePlan ?? "FREE")
      if (sponsorPlan === "FREE" && !urlEngineBacked) {
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
      if (sponsorPlan !== "FREE" && urlEngineBacked) {
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
            message: "Verify control of this domain once to enable engine-backed reviews.",
            plan: sponsorPlan,
            isTrial: false,
            remainingMinutes: 0,
            remediation: {
              txtName: domain ? `_lyrashield.${domain}` : null,
              verifyPath: `/dashboard/targets/${target.id}`,
            },
          })
        }
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
    // unsupported combination returned above. The sponsor is the caller's
    // account (subscriptions are account-owned).
    const entitlement = await evaluateScanEntitlement({
      workspaceId,
      mode: canonicalMode,
      sponsorAccountId: session.userId,
      mutateOnTrialExpiry: false,
    })
    const trialAvailable =
      !entitlement.allowed &&
      entitlement.code === "NO_MINUTES_REMAINING" &&
      entitlement.plan === "FREE" &&
      !entitlement.isTrial &&
      (await isTrialAvailable(workspaceId, session.userId))

    logger.info("Scan eligibility preflight", {
      workspaceId,
      targetId,
      allowed: entitlement.allowed,
      code: entitlement.code ?? null,
    })

    return eligibilityResponse({
      allowed: entitlement.allowed,
      profile: {
        id: resolveScanProfile({ targetType: target.type, mode }).id,
        canonicalMode,
        scope: "expected",
      },
      code: entitlement.allowed
        ? null
        : trialAvailable
          ? "TRIAL_AVAILABLE"
          : (entitlement.code ?? "SCAN_NOT_ALLOWED"),
      message: entitlement.allowed
        ? null
        : trialAvailable
          ? "Start your 7-day trial to receive 60 agent-minutes."
          : (entitlement.message ?? "Scan not allowed"),
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
