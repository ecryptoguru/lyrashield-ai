import { isDeepStrictEqual } from "node:util"
import type { Target } from "@lyrashield/db"
import type { AuthSession } from "@lyrashield/auth/server"
import type { SetupAuthorityEvidence } from "../../../../lib/setup-health-authority"
import {
  captureSetupActor,
  captureSetupAttachments,
  captureSetupIntent,
  captureSetupTarget,
  emptySetupEvidence,
  type ScanSetupInput,
} from "./evidence"
import { evaluateRemotePreflight } from "./remote-preflight"
import { readSetupSourceIdentity } from "./source-preflight"
import { withWorkspaceRLS, resolveScanAttachments, ScanAttachmentError } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  CreateScanInputSchema,
  CreateScanSchema,
  EngineBudgetCeilingTextSchema,
} from "@lyrashield/types"
import { evaluateScanEntitlement, isTrialAvailable } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import {
  eligibilityResponse,
  evaluatePolicyAndWorkflow,
  prepareReviewOptions,
  type EligibilityBlocker,
} from "./preflight-helpers"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"
import { checkScanEligibilityRateLimit } from "../../../../lib/rate-limit"
import {
  matchReviewOption,
  resolveCanonicalReviewMode,
  resolveAvailableUrlReview,
} from "../../../../lib/scan-admission"

/**
 * The eligibility query shares POST /api/scans' input contract minus the
 * submission-only fields (focus). Policy selection is retained because it
 * changes workflow admission. Cross-field workflow rules are
 * applied by re-validating through CreateScanInputSchema, so a preflight can
 * never pass a combination the mutation gate would reject at parse time.
 */
const EligibilityQuerySchema = CreateScanSchema.pick({
  workspaceId: true,
  targetId: true,
  goal: true,
  mode: true,
  policyId: true,
  engineBudgetCeilingUsd: true,
  workflow: true,
  baseRef: true,
  headRef: true,
  attachmentIds: true,
  authorizationRef: true,
}).extend({ engineBudgetCeilingUsd: EngineBudgetCeilingTextSchema.optional() })

function parseEligibilityQuery(searchParams: URLSearchParams) {
  const raw: Record<string, unknown> = Object.fromEntries(searchParams)
  // attachmentIds is a repeated query param — Object.fromEntries would keep
  // only the last occurrence, so rebuild it from getAll before validation.
  const attachmentParams = searchParams.getAll("attachmentIds")
  if (attachmentParams.length > 0) raw.attachmentIds = attachmentParams
  const ceilings = searchParams.getAll("engineBudgetCeilingUsd")
  if (ceilings.length > 1) raw.engineBudgetCeilingUsd = ceilings
  return EligibilityQuerySchema.safeParse(raw)
}

/** Read-only advisory evaluation. Scan creation repeats admission. */
export async function evaluateScanSetup(
  request: Request,
  options: { resolveSource?: boolean } = {}
): Promise<{ response: Response; evidence: SetupAuthorityEvidence }> {
  const evidence = emptySetupEvidence()
  const response = await runEvaluation(request, evidence, options.resolveSource === true)
  const payload = await response
    .clone()
    .json()
    .catch(() => null)
  if (payload?.success === true) {
    evidence.outcome = {
      allowed: payload.data?.allowed === true,
      code: payload.data?.code ?? null,
      blockers: Array.isArray(payload.data?.blockers)
        ? payload.data.blockers.map((blocker: { code?: string }) => blocker.code ?? null)
        : [],
    }
  }
  return { response, evidence }
}

async function runEvaluation(
  request: Request,
  evidence: SetupAuthorityEvidence,
  resolveSource: boolean
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url)
    const parsed = parseEligibilityQuery(searchParams)
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
    captureSetupIntent(evidence, input)
    // `goal` is part of the validated contract (and the composer's identity
    // for a review) but does not change eligibility on its own.
    void input.goal

    // Same workspace permission and target ownership checks as scan creation.
    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.scan.create)
    captureSetupActor(evidence, session, workspace)

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

    const target = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.findFirst({ where: { id: targetId, workspaceId, deletedAt: null } })
    )
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    // Same delegated-scope assertion POST applies — an out-of-grant preflight
    // can never report an allowed verdict the mutation would refuse.
    assertOAuthDelegatedScope(session, targetId, mode)
    captureSetupTarget(evidence, target)
    if (resolveSource && target.type === "REPO" && target.installationId) {
      const connection = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.integration.findFirst({
          where: {
            workspaceId,
            type: "GITHUB",
            externalId: target.installationId,
            deletedAt: null,
          },
          select: { id: true, status: true, updatedAt: true },
        })
      )
      evidence.connection = connection ?? "UNAVAILABLE"
    } else if (target.type === "REPO" && target.installationId) {
      evidence.connection = "UNAVAILABLE"
    } else {
      evidence.connection = null
    }
    return await evaluateTarget({ request, input, session, target, evidence, resolveSource })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to evaluate scan eligibility", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to evaluate scan eligibility", 500)
  }
}

async function evaluateTarget({
  request,
  input,
  session,
  target,
  evidence,
  resolveSource,
}: {
  request: Request
  input: ScanSetupInput
  session: AuthSession
  target: Target
  evidence: SetupAuthorityEvidence
  resolveSource: boolean
}): Promise<Response> {
  const { workspaceId, mode } = input
  // The review options the target currently offers — the same pure option
  // policy the composer and POST derive, projected without billing work.
  const { reviewOptions, advisory, targetRelayAvailable } = await prepareReviewOptions(target)
  evidence.relay = { available: targetRelayAvailable }

  // Workspace-scoped attachment IDs are validated exactly as POST resolves
  // them — unknown or cross-workspace IDs are an advisory blocker. Metadata
  // rows only; attachment content is never downloaded here.
  const attachmentIds = input.attachmentIds ? [...new Set(input.attachmentIds)] : []
  evidence.attachments = []
  if (attachmentIds.length > 0) {
    try {
      const attachments = await resolveScanAttachments(workspaceId, attachmentIds)
      captureSetupAttachments(evidence, attachments)
    } catch (error) {
      if (error instanceof ScanAttachmentError) {
        evidence.attachments = { state: "DENIED", code: error.code }
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
  const urlAdmission = await resolveAvailableUrlReview(
    {
      targetType: target.type,
      mode,
      hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
    },
    targetRelayAvailable
  )
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

  const remote = await evaluateRemotePreflight({
    request,
    workspaceId,
    actorUserId: session.userId,
    target,
    engineBacked: urlAdmission.engineBacked,
    advisory,
    evidence,
  })
  if (remote) return remote

  if (resolveSource) {
    evidence.source = await readSetupSourceIdentity(
      target,
      input,
      evidence.connection,
      request.signal
    )
    if (target.type === "REPO") {
      const boundaryError = await recheckSourceBoundary(input, target, evidence, advisory)
      if (boundaryError) return boundaryError
    }
  }

  return evaluateEntitlement({ input, session, target, evidence, reviewOptions, advisory })
}

async function recheckSourceBoundary(
  input: ScanSetupInput,
  target: Target,
  evidence: SetupAuthorityEvidence,
  advisory: Awaited<ReturnType<typeof prepareReviewOptions>>["advisory"]
): Promise<Response | null> {
  const { session, workspace } = await requirePermission(input.workspaceId, PERMISSIONS.scan.create)
  assertOAuthDelegatedScope(session, input.targetId, input.mode)
  const latest = emptySetupEvidence()
  captureSetupActor(latest, session, workspace)
  const currentTarget = await withWorkspaceRLS(input.workspaceId, (tx) =>
    tx.target.findFirst({
      where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
    })
  )
  if (!currentTarget) return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
  captureSetupTarget(latest, currentTarget)
  const connection = target.installationId
    ? await withWorkspaceRLS(input.workspaceId, (tx) =>
        tx.integration.findFirst({
          where: {
            workspaceId: input.workspaceId,
            type: "GITHUB",
            externalId: target.installationId,
            deletedAt: null,
          },
          select: { id: true, status: true, updatedAt: true },
        })
      )
    : null
  if (
    !isDeepStrictEqual(latest.actor, evidence.actor) ||
    !isDeepStrictEqual(latest.target, evidence.target) ||
    !isDeepStrictEqual(connection ?? "UNAVAILABLE", evidence.connection ?? "UNAVAILABLE")
  ) {
    evidence.source = "UNAVAILABLE"
    evidence.actor = "UNAVAILABLE"
  }
  const attachmentIds = [...new Set(input.attachmentIds ?? [])]
  if (attachmentIds.length > 0) {
    try {
      captureSetupAttachments(
        evidence,
        await resolveScanAttachments(input.workspaceId, attachmentIds)
      )
    } catch (error) {
      if (!(error instanceof ScanAttachmentError)) throw error
      evidence.attachments = { state: "DENIED", code: error.code }
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
  }
  return null
}

async function evaluateEntitlement({
  input,
  session,
  target,
  evidence,
  reviewOptions,
  advisory,
}: {
  input: ScanSetupInput
  session: AuthSession
  target: Target
  evidence: SetupAuthorityEvidence
  reviewOptions: Awaited<ReturnType<typeof prepareReviewOptions>>["reviewOptions"]
  advisory: Awaited<ReturnType<typeof prepareReviewOptions>>["advisory"]
}): Promise<Response> {
  const { workspaceId, targetId, mode } = input
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

  evidence.entitlement = entitlement.accountId
    ? {
        accountId: entitlement.accountId,
        allowed: entitlement.allowed,
        code: entitlement.code ?? null,
        plan: entitlement.plan,
        isTrial: entitlement.isTrial,
        remainingMinutes: entitlement.remainingMinutes,
        trialAvailable,
      }
    : "UNAVAILABLE"

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
  const workflowCheck = await evaluatePolicyAndWorkflow(
    input,
    target,
    workspaceId,
    targetId,
    evidence
  )
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
}
