import {
  LiveAiSafetyError,
  prisma,
  resolveAuthenticatedAssessmentAuthorization,
  resolveScanAttachments,
  ScanAttachmentError,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateScanInputSchema, CreateScanSchema } from "@lyrashield/types"
import { evaluateScanEntitlement, isTrialAvailable } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"
import {
  peekFreeUrlScanRateLimit,
  checkScanEligibilityRateLimit,
  clientIpFromRequest,
} from "../../../../lib/rate-limit"
import {
  authAssessmentAdmission,
  findCurrentDomainProof,
  findScanPolicy,
  listAdmissibleReviewOptions,
  matchReviewOption,
  resolveCanonicalReviewMode,
  resolveSponsorScanPlan,
  resolveUrlReviewMode,
} from "../../../../lib/scan-admission"

/**
 * The eligibility query shares POST /api/scans' input contract minus the
 * submission-only fields (policyId, focus). Cross-field workflow rules are
 * applied by re-validating through CreateScanInputSchema, so a preflight can
 * never pass a combination the mutation gate would reject at parse time.
 */
const EligibilityQuerySchema = CreateScanSchema.pick({
  workspaceId: true,
  targetId: true,
  goal: true,
  mode: true,
  workflow: true,
  baseRef: true,
  headRef: true,
  attachmentIds: true,
  authorizationRef: true,
})

type EligibilityBlocker = { code: string; message: string }

/** Bounded projection of a manual-scan option for the advisory contract —
 * decision-relevant fields only: no minute estimates, model names or costs. */
type SupportedMode = {
  id: string
  label: string
  goal: string
  mode: string
  workflow: string
  available: boolean
  disabledReason: string | null
  usesAi: boolean | null
  requiresRevisionInputs: boolean
  authorizationHint: string | null
}

type AdvisoryFields = {
  canonicalMode?: string
  canonicalProfileId?: string
  supportedModes?: SupportedMode[]
  expectedScannerFamilies?: string[]
}

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
 * Workflow-gate checks the preflight can answer cheaply and honestly — the
 * same gates POST applies, minus the parts that require submission work.
 * Failures are returned as blockers; evidence the endpoint cannot establish
 * (immutable ref resolution happens only at creation) is a limitation, never
 * a denial.
 */
async function evaluateWorkflowPreflight(input: {
  workspaceId: string
  targetId: string
  target: {
    type: string
    installationId?: unknown
    repoOwner?: string | null
    repoName?: string | null
    repoFullName?: string | null
  }
  workflow?: string
  authorizationRef?: string
}): Promise<{ blockers: EligibilityBlocker[]; limitations: string[] }> {
  const blockers: EligibilityBlocker[] = []
  const limitations: string[] = []

  if (input.workflow === "REVIEW_CHANGES") {
    if (input.target.type !== "REPO") {
      blockers.push({
        code: "SCAN_PLAN_INVALID",
        message: "Review Changes requires a repository target.",
      })
    } else {
      const installationId = input.target.installationId
        ? Number(input.target.installationId)
        : null
      const repoOwner = input.target.repoOwner ?? input.target.repoFullName?.split("/")[0]
      const repoName = input.target.repoName ?? input.target.repoFullName?.split("/")[1]
      if (!installationId || !repoOwner || !repoName) {
        blockers.push({
          code: "SCAN_SOURCE_UNAVAILABLE",
          message: "Review Changes requires a repository connected through the GitHub App.",
        })
      } else {
        // Resolving refs through the authorized GitHub integration is
        // submission work — report it as unavailable evidence, not a denial.
        limitations.push(
          "Comparison refs and merge base resolve to immutable revisions only when the scan is submitted."
        )
      }
    }
  }

  if (input.workflow === "AUTHENTICATED_ASSESSMENT") {
    const admission = authAssessmentAdmission(input.workspaceId, input.targetId)
    if (!admission.allowed) {
      blockers.push({
        code: "SCAN_WORKFLOW_UNAVAILABLE",
        message: "Authenticated assessment is not enabled for this workspace and target.",
      })
    } else if (input.target.type !== "WEB_APP" && input.target.type !== "API") {
      blockers.push({
        code: "SCAN_PLAN_INVALID",
        message: "Authenticated assessment requires a live web app or API target.",
      })
    } else {
      // Same order as POST: a destructive-allowed policy forbids the beta,
      // then the recorded scoped authorization must cover this exact target.
      const policy = await findScanPolicy(input.workspaceId)
      if (policy?.destructiveTestsAllowed === true) {
        blockers.push({
          code: "SCAN_PLAN_DENIED",
          message:
            "The selected policy allows destructive tests, which the authenticated assessment forbids.",
        })
      } else if (input.authorizationRef) {
        try {
          await resolveAuthenticatedAssessmentAuthorization({
            workspaceId: input.workspaceId,
            targetId: input.targetId,
            authorizationRef: input.authorizationRef,
          })
        } catch (error) {
          if (error instanceof LiveAiSafetyError) {
            blockers.push({
              code: error.code,
              message: "The recorded assessment authorization does not cover this target.",
            })
          } else {
            throw error
          }
        }
      }
    }
  }

  return { blockers, limitations }
}

/**
 * Read-only scan eligibility preflight.
 *
 * Advisory: the composer calls this so Start can be disabled with a reason
 * before submission, but POST /api/scans repeats the authoritative check
 * immediately before creation — a preflight pass never replaces the mutation
 * gate. This endpoint performs no trial, billing, scan, or audit mutation and
 * returns no monetary amount, model identifier, or upstream-engine detail.
 * It never creates a target, uploads an attachment, fetches caller URLs,
 * resolves repository refs, or consumes the free-URL allowance (peek only).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const raw: Record<string, unknown> = Object.fromEntries(searchParams)
    // attachmentIds is a repeated query param — Object.fromEntries would keep
    // only the last occurrence, so rebuild it from getAll before validation.
    const attachmentParams = searchParams.getAll("attachmentIds")
    if (attachmentParams.length > 0) raw.attachmentIds = attachmentParams
    const parsed = EligibilityQuerySchema.safeParse(raw)
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }
    const refined = CreateScanInputSchema.safeParse(parsed.data)
    if (!refined.success) {
      return apiError(
        "INVALID_PARAM",
        refined.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }
    const input = refined.data
    const { workspaceId, targetId, mode } = input
    // `goal` is part of the validated contract (and the composer's identity
    // for a review) but does not change eligibility on its own.
    void input.goal

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

    // Same delegated-scope assertion POST applies — an out-of-grant preflight
    // can never report an allowed verdict the mutation would refuse.
    assertOAuthDelegatedScope(session, targetId, mode)

    // The review options the target currently offers — the same pure option
    // policy the composer and POST derive, projected without billing work.
    const reviewOptions = listAdmissibleReviewOptions({
      type: target.type,
      hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
    })
    const supportedModes: SupportedMode[] = reviewOptions.map((option) => ({
      id: option.id,
      label: option.label,
      goal: option.goal,
      mode: option.mode,
      workflow: option.workflow,
      available: option.available,
      disabledReason: option.disabledReason ?? null,
      usesAi: option.usesAi ?? null,
      requiresRevisionInputs: option.requiresRevisionInputs ?? false,
      authorizationHint: option.authorizationHint ?? null,
    }))
    const advisory: AdvisoryFields = { supportedModes }

    // Workspace-scoped attachment IDs are validated exactly as POST resolves
    // them — unknown or cross-workspace IDs are an advisory blocker. Metadata
    // rows only; attachment content is never downloaded here.
    const attachmentIds = input.attachmentIds ? [...new Set(input.attachmentIds)] : []
    if (attachmentIds.length > 0) {
      try {
        await resolveScanAttachments(workspaceId, attachmentIds)
      } catch (error) {
        if (error instanceof ScanAttachmentError) {
          return eligibilityResponse({
            allowed: false,
            code: error.code,
            message: error.message,
            plan: "UNKNOWN",
            isTrial: false,
            remainingMinutes: 0,
            blockers: [{ code: error.code, message: error.message }],
            ...advisory,
          })
        }
        throw error
      }
    }

    // Resolve the canonical review profile exactly as POST does, so the
    // preflight judges the review the run would actually perform — including
    // whether the tier is engine-backed (which decides the consent gates).
    const urlAdmission = resolveUrlReviewMode({
      targetType: target.type,
      mode,
      hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
    })
    if (!urlAdmission.ok) {
      return eligibilityResponse({
        allowed: false,
        code: urlAdmission.code,
        message: urlAdmission.reason,
        plan: "UNKNOWN",
        isTrial: false,
        remainingMinutes: 0,
        blockers: [{ code: urlAdmission.code, message: urlAdmission.reason }],
        ...advisory,
      })
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
      const sponsorPlan = await resolveSponsorScanPlan(workspaceId, session.userId)
      if (sponsorPlan === "FREE" && !urlAdmission.engineBacked) {
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
            blockers: [
              {
                code: "FREE_URL_SCAN_RATE_LIMITED",
                message:
                  "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews.",
              },
            ],
            ...advisory,
          })
        }
      }
      if (sponsorPlan !== "FREE" && urlAdmission.engineBacked) {
        const { domain, verified } = await findCurrentDomainProof(workspaceId, target.url)
        if (!verified) {
          return eligibilityResponse({
            allowed: false,
            code: "DOMAIN_VERIFICATION_REQUIRED",
            message: "Verify control of this domain once to enable engine-backed reviews.",
            plan: sponsorPlan,
            isTrial: false,
            remainingMinutes: 0,
            blockers: [
              {
                code: "DOMAIN_VERIFICATION_REQUIRED",
                message: "Verify control of this domain once to enable engine-backed reviews.",
              },
            ],
            remediation: {
              txtName: domain ? `_lyrashield.${domain}` : null,
              verifyPath: `/dashboard/targets/${target.id}`,
            },
            ...advisory,
          })
        }
      }
    }

    const canonical = resolveCanonicalReviewMode({ targetType: target.type, mode })
    if (!canonical.ok) {
      return eligibilityResponse({
        allowed: false,
        code: canonical.code,
        message:
          canonical.code === "TARGET_TYPE_UNSUPPORTED"
            ? "This target cannot be reviewed yet."
            : "This review type is not available for the selected target.",
        plan: "UNKNOWN",
        isTrial: false,
        remainingMinutes: 0,
        blockers: [
          {
            code: canonical.code,
            message:
              canonical.code === "TARGET_TYPE_UNSUPPORTED"
                ? "This target cannot be reviewed yet."
                : "This review type is not available for the selected target.",
          },
        ],
        ...advisory,
      })
    }

    advisory.canonicalMode = canonical.canonicalMode
    if (canonical.profileId) advisory.canonicalProfileId = canonical.profileId
    const matchedOption = matchReviewOption(reviewOptions, {
      profileId: canonical.profileId,
      canonicalMode: canonical.canonicalMode,
      workflow: input.workflow,
    })
    if (matchedOption) {
      // EXPECTED coverage at admission — never a claim of what a scan will
      // have completed.
      advisory.expectedScannerFamilies = [...matchedOption.applicableChecks]
    }

    // Read-only entitlement evaluation: no trial/billing mutation on GET.
    // canonicalMode is a resolved profile mode at this point — every
    // unsupported combination returned above. The sponsor is the caller's
    // account (subscriptions are account-owned).
    const entitlement = await evaluateScanEntitlement({
      workspaceId,
      mode: canonical.canonicalMode,
      sponsorAccountId: session.userId,
      mutateOnTrialExpiry: false,
    })
    const trialAvailable =
      !entitlement.allowed &&
      entitlement.code === "NO_MINUTES_REMAINING" &&
      entitlement.plan === "FREE" &&
      !entitlement.isTrial &&
      (await isTrialAvailable(workspaceId, session.userId))

    const blockers: EligibilityBlocker[] = []
    if (!entitlement.allowed) {
      blockers.push({
        code: trialAvailable ? "TRIAL_AVAILABLE" : (entitlement.code ?? "SCAN_NOT_ALLOWED"),
        message: trialAvailable
          ? "Start your 7-day trial to receive 60 agent-minutes."
          : (entitlement.message ?? "Scan not allowed"),
      })
    }

    // The workflow gates POST evaluates after the entitlement check. A denied
    // entitlement stays the top-level verdict (matching POST order); further
    // workflow blockers are reported alongside so callers see every known
    // reason without a second call.
    const workflowCheck = await evaluateWorkflowPreflight({
      workspaceId,
      targetId,
      target,
      workflow: input.workflow,
      authorizationRef: input.authorizationRef,
    })
    blockers.push(...workflowCheck.blockers)

    logger.info("Scan eligibility preflight", {
      workspaceId,
      targetId,
      allowed: blockers.length === 0,
      code: blockers[0]?.code ?? null,
    })

    const first = blockers[0]
    return eligibilityResponse({
      allowed: blockers.length === 0,
      code: first?.code ?? null,
      message: first?.message ?? null,
      plan: entitlement.plan,
      isTrial: entitlement.isTrial,
      remainingMinutes: entitlement.remainingMinutes,
      blockers,
      ...(workflowCheck.limitations.length > 0 ? { limitations: workflowCheck.limitations } : {}),
      ...advisory,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to evaluate scan eligibility", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to evaluate scan eligibility", 500)
  }
}
