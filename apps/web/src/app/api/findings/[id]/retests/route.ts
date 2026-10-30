import { retestCreationError } from "@/lib/scan-admission-conflicts"
import { releaseUnstartedScanSlot } from "@lyrashield/db"
import { recordedOperation } from "@/lib/recorded-operation"
import { withCookieMutation } from "../../../../../lib/api-auth"
import {
  createScan,
  findCurrentDomainProof,
  getFindingReference,
  prisma,
  updateScanStatus,
} from "@lyrashield/db"
import { type ScanMode, resolveTargetScanMode } from "@lyrashield/types"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { assertScanAllowed } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { z } from "zod"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../../../lib/queue"
import { resolveRetestProfile } from "../../../../../lib/retest-profile"
import { revalidateDashboardAggregates } from "../../../../../lib/cache"
import {
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  clientIpFromRequest,
} from "../../../../../lib/rate-limit"
import { resolveSponsorScanPlan, resolveUrlReviewMode } from "../../../../../lib/scan-admission"

const CreateRetestSchema = z.object({
  workspaceId: z.string().min(1),
  // Retests derive their target and mode from the finding's source scan. Keep
  // this optional only for backwards-compatible clients; it is never trusted.
  scanId: z.string().optional(),
})

async function checkRetestAdmission({
  request,
  workspaceId,
  userId,
  target,
  mode,
  confirmNotSubmitted,
}: {
  request: Request
  workspaceId: string
  userId: string
  target: Pick<
    NonNullable<Awaited<ReturnType<typeof prisma.target.findFirst>>>,
    "id" | "type" | "apiSpecUrl" | "url"
  >
  mode: ScanMode
  confirmNotSubmitted: () => void
}) {
  const urlAdmission = resolveUrlReviewMode({
    targetType: target.type,
    mode,
    hasApiSpec: Boolean(target.apiSpecUrl),
  })
  if (!urlAdmission.ok) {
    confirmNotSubmitted()
    return apiError(urlAdmission.code, "This retest profile is not available for the target.", 400)
  }

  const isRemoteUrlTarget = target.type === "WEB_APP" || target.type === "API"
  const sponsorPlan = isRemoteUrlTarget ? await resolveSponsorScanPlan(workspaceId, userId) : null
  if (isRemoteUrlTarget && urlAdmission.engineBacked) {
    const { domain, verified } = await findCurrentDomainProof(workspaceId, target.url)
    if (!verified) {
      confirmNotSubmitted()
      return apiError(
        "DOMAIN_VERIFICATION_REQUIRED",
        "Verify control of this domain once to enable engine-backed reviews.",
        403,
        undefined,
        {
          remediation: {
            txtName: domain ? `_lyrashield.${domain}` : null,
            verifyPath: `/dashboard/targets/${target.id}`,
          },
        }
      )
    }
  }

  const entitlement = await assertScanAllowed(workspaceId, mode, userId)
  if (!entitlement.allowed) {
    confirmNotSubmitted()
    return apiError(
      entitlement.code ?? "SCAN_NOT_ALLOWED",
      entitlement.message ?? "This account is not currently eligible to run the retest.",
      403,
      undefined,
      {
        plan: entitlement.plan,
        isTrial: entitlement.isTrial,
        remainingMinutes: entitlement.remainingMinutes,
      }
    )
  }

  if (isRemoteUrlTarget && sponsorPlan === "FREE" && !urlAdmission.engineBacked) {
    const freeUrlLimit = await checkFreeUrlScanRateLimit(clientIpFromRequest(request))
    if (freeUrlLimit.limited) {
      confirmNotSubmitted()
      return apiError(
        "FREE_URL_SCAN_RATE_LIMITED",
        "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews.",
        429,
        { "Retry-After": String(Math.max(freeUrlLimit.retryAfter, 1)) }
      )
    }
  }

  const scanRate = await checkScanCreateRateLimit(workspaceId)
  if (scanRate.limited) {
    confirmNotSubmitted()
    return apiError(
      "SCAN_RATE_LIMITED",
      "Too many reviews started in the last minute. Please wait a moment and try again.",
      429,
      { "Retry-After": String(Math.max(scanRate.retryAfter, 1)) }
    )
  }
  return null
}

async function checkRetestAvailability(
  findingId: string,
  workspaceId: string,
  confirmNotSubmitted: () => void
) {
  const existingPending = await prisma.retest.findFirst({
    where: { findingId, workspaceId, status: { in: ["pending", "running"] } },
  })
  if (existingPending) {
    return apiError("RETEST_IN_PROGRESS", "A retest is already in progress for this finding", 409)
  }

  try {
    await assertScanWorkerAvailable()
  } catch (error) {
    if (error instanceof ScanWorkerUnavailableError) {
      confirmNotSubmitted()
      return apiError(
        "SCAN_SERVICE_UNAVAILABLE",
        "Retesting is temporarily unavailable. Please try again shortly.",
        503
      )
    }
    throw error
  }
  return null
}

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = CreateRetestSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.retest.create)

    const finding = await getFindingReference(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    if (!finding.targetId) {
      return apiError("RETEST_UNAVAILABLE", "This finding has no target to retest", 409)
    }
    assertOAuthDelegatedScope(session, finding.targetId)

    const sourceScan = await prisma.scan.findFirst({
      where: { id: finding.scanId, workspaceId, targetId: finding.targetId, deletedAt: null },
      select: { id: true, targetId: true, goal: true, mode: true, policyId: true },
    })
    if (!sourceScan?.targetId) {
      return apiError("RETEST_UNAVAILABLE", "The finding's source scan is unavailable", 409)
    }

    const target = await prisma.target.findFirst({
      where: { id: sourceScan.targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("RETEST_UNAVAILABLE", "The finding's target is unavailable", 409)
    }

    const resolved = resolveTargetScanMode({
      targetType: target.type,
      mode: sourceScan.mode,
      hasApiSpec: Boolean(target.apiSpecUrl),
    })
    if (!resolved.ok) {
      return apiError(resolved.code, resolved.reason, 400)
    }

    const candidates = await prisma.findingCandidate.findMany({
      where: { findingId: id, workspaceId, scanId: sourceScan.id },
      select: { scannerSource: true },
    })
    const retestProfile = resolveRetestProfile(
      sourceScan.mode,
      candidates.map((candidate) => candidate.scannerSource)
    )

    const retestResolved = resolveTargetScanMode({
      targetType: target.type,
      mode: retestProfile.mode,
      hasApiSpec: Boolean(target.apiSpecUrl),
    })
    if (!retestResolved.ok) {
      return apiError(retestResolved.code, retestResolved.reason, 400)
    }

    const retestTargetId = sourceScan.targetId
    assertOAuthDelegatedScope(session, retestTargetId, retestProfile.mode)
    return await recordedOperation(
      request,
      {
        workspaceId,
        operationName: "retest.create",
        input: { ...parsed.data, findingId: id },
        session,
      },
      async ({ confirmNotSubmitted }) => {
        assertOAuthDelegatedScope(session, finding.targetId, retestProfile.mode)
        const admissionError = await checkRetestAdmission({
          request,
          workspaceId,
          userId: session.userId,
          target,
          mode: retestProfile.mode,
          confirmNotSubmitted,
        })
        if (admissionError) return admissionError

        const availabilityError = await checkRetestAvailability(
          id,
          workspaceId,
          confirmNotSubmitted
        )
        if (availabilityError) return availabilityError

        let scan: Awaited<ReturnType<typeof createScan>>
        try {
          scan = await createScan({
            workspaceId,
            targetId: retestTargetId,
            goal: sourceScan.goal,
            mode: retestProfile.mode as ScanMode,
            policyId: sourceScan.policyId ?? undefined,
            createdById: session.userId,
            triggerType: "retest",
            determinismMode: retestProfile.determinismMode,
            // W0.4 — bind the delegated grant verified synchronously above into
            // the durable scan record so execution-time admission re-checks it.
            ...(session.oauth?.connectionId && session.oauth.authorizationVersion
              ? {
                  delegatedConnection: {
                    connectionId: session.oauth.connectionId,
                    authorizationVersion: session.oauth.authorizationVersion,
                  },
                }
              : {}),
          })
        } catch (error) {
          const response = retestCreationError(error, confirmNotSubmitted)
          if (response) return response
          throw error
        }

        let retest: { id: string }
        try {
          retest = await prisma.retest.create({
            data: {
              workspaceId,
              findingId: id,
              scanId: scan.id,
              status: "pending",
              resultBefore: retestProfile.reason,
            },
          })
        } catch (error) {
          await updateScanStatus(scan.id, "FAILED", {
            errorCategory: "RETEST_SETUP",
            errorMessage: "Retest could not be prepared before queueing",
          })
          await releaseUnstartedScanSlot(workspaceId, scan.id)
          throw error
        }

        try {
          await enqueueScanJob({
            scanId: scan.id,
            workspaceId,
            targetId: retestTargetId,
            goal: sourceScan.goal,
            mode: retestProfile.mode as ScanMode,
            policyId: sourceScan.policyId ?? undefined,
          })
        } catch (enqueueError) {
          await updateScanStatus(scan.id, "FAILED", {
            errorCategory: "QUEUE",
            errorMessage: "Scan worker became unavailable while queueing the retest",
          })
          await prisma.retest.update({
            where: { id: retest.id },
            data: { status: "error", resultAfter: "Retest could not be queued." },
          })
          await releaseUnstartedScanSlot(workspaceId, scan.id)
          logger.error("Failed to enqueue retest scan", {
            findingId: id,
            scanId: scan.id,
            error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          })
          revalidateDashboardAggregates(workspaceId)
          return apiError(
            "SCAN_SERVICE_UNAVAILABLE",
            "Retesting became unavailable while starting. Please try again shortly.",
            503
          )
        }

        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "retest.queued",
            resourceType: "retest",
            resourceId: retest.id,
          },
        })

        revalidateDashboardAggregates(workspaceId)
        return apiSuccess({ retest, scan: { id: scan.id, status: scan.status } }, 201)
      }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create retest", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create retest", 500)
  }
}

export const POST = withCookieMutation(post)
