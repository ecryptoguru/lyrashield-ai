import { withCookieMutation } from "../../../lib/api-auth"
import { createHash } from "crypto"
import {
  prisma,
  createScan,
  listScans,
  updateScanStatus,
  claimOrGetAgentOperation,
  completeAgentOperation,
  toJsonObject,
  failAgentOperation,
  resolveScanAttachments,
  resolveAuthenticatedAssessmentAuthorization,
  LiveAiSafetyError,
  ScanAttachmentError,
  WorkspaceScanConcurrencyLimitError,
  type ScanListItem,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  CreateScanInputSchema,
  MAX_CONCURRENT_WORKSPACE_SCANS,
  ScanExecutionPlanInputError,
  ScanStatusSchema,
} from "@lyrashield/types"
import { parseScanStateFilter, scanStateStatuses } from "@/lib/scan-presentation"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { z } from "zod"
import { assertScanAllowed } from "@lyrashield/billing"
import {
  authAssessmentAdmission,
  findCurrentDomainProof,
  findScanPolicy,
  resolveCanonicalReviewMode,
  resolveSponsorScanPlan,
  resolveUrlReviewMode,
} from "../../../lib/scan-admission"
import { revalidateDashboardAggregates } from "../../../lib/cache"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, parsePaginationParams } from "../../../lib/api-response"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"
import { getBranchRefSha, getDefaultBranch, getMergeBaseSha } from "@lyrashield/integrations"
import {
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  clientIpFromRequest,
} from "../../../lib/rate-limit"
import { refuseScan } from "../../../lib/scan-refusal"

/** Full lowercase git object IDs (SHA-1 = 40, SHA-256 = 64) pass through as
 * immutable revisions; anything else resolves through the installation. */
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

async function resolveRepoRevision(
  installationId: number,
  owner: string,
  repo: string,
  ref: string
): Promise<string> {
  if (FULL_GIT_OBJECT_ID.test(ref)) return ref
  return getBranchRefSha(installationId, owner, repo, ref)
}
const ScanIdQuerySchema = z
  .array(z.string().trim().min(1).max(128))
  .min(1)
  .max(MAX_CONCURRENT_WORKSPACE_SCANS)

/**
 * Concurrent in-flight reviews per workspace (shared with the scheduled-scan
 * runner via @lyrashield/types). Each running scan holds a worker slot and
 * commits model spend, so this bounds both blast radius and cost while leaving
 * normal multi-product use unaffected.
 */

/**
 * Serialize a scan list row for the client. Dates become ISO strings so the
 * polled payload matches the SSR-rendered shape exactly (the client's ScanItem
 * type expects strings, and `findingCount` is already flattened by listScans).
 */
function serializeScanListItem(scan: ScanListItem) {
  return {
    ...scan,
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    createdAt: scan.createdAt.toISOString(),
  }
}

/**
 * ETag over the entire response representation. The active-scan poll re-requests
 * this list on an interval; when nothing has moved the client gets a 304 with no
 * body to parse.
 *
 * Hashing the full payload (not a subset of fields) is deliberate: a summary,
 * error message, or target rename can change while status and counts stay put,
 * and a partial hash would then serve a 304 and freeze stale data on screen.
 */
function scanListEtag(
  items: ReturnType<typeof serializeScanListItem>[],
  nextCursor: string | null
): string {
  // Hash the exact response representation, envelope included: the body is
  // { success, data: { items, nextCursor } }, so any envelope change also
  // invalidates the tag instead of serving a stale-shaped 304.
  const payload = JSON.stringify({ success: true, data: { items, nextCursor } })
  return `"${createHash("sha256").update(payload).digest("hex")}"`
}

async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = CreateScanInputSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const data = parsed.data
  const workspaceId = data.workspaceId

  let operationClaim: Awaited<ReturnType<typeof claimOrGetAgentOperation>> | null = null
  let submissionAttempted = false
  let submittedScanId: string | undefined
  let operationCompleted = false
  // Captured once auth succeeds so catch-block refusals can attribute the actor.
  let actorUserId: string | undefined
  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)
    actorUserId = session.userId

    const target = await prisma.target.findFirst({
      where: { id: data.targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "target_not_found",
        code: "TARGET_NOT_FOUND",
        message: "Target not found in this workspace",
        status: 404,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }

    assertOAuthDelegatedScope(session, data.targetId, data.mode)

    // Resolve workspace-scoped attachment IDs before any billing/queue work.
    // The stored rows — never client-supplied fields — prove ownership,
    // freshness, content type, and checksum; unknown or cross-workspace IDs
    // fail closed, and host paths are never accepted as attachment input.
    const attachmentIds = data.attachmentIds ? [...new Set(data.attachmentIds)] : []
    if (attachmentIds.length > 0) {
      try {
        await resolveScanAttachments(workspaceId, attachmentIds)
      } catch (error) {
        if (error instanceof ScanAttachmentError) {
          return refuseScan({
            workspaceId,
            actorUserId,
            reason: "attachment_rejected",
            code: error.code,
            message: error.message,
            status: error.code === "SCAN_ATTACHMENT_NOT_FOUND" ? 404 : 400,
            targetId: data.targetId,
            mode: data.mode,
            workflow: data.workflow,
          })
        }
        throw error
      }
    }

    // Resolve the URL profile first so the consent gates track what the scan
    // actually does: engine-backed tiers (STANDARD/DEEP) require a verified
    // domain on paid plans, while the deterministic-only tier needs no proof —
    // it only fetches what a browser could.
    const urlAdmission = resolveUrlReviewMode({
      targetType: target.type,
      mode: data.mode,
      hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
    })
    if (!urlAdmission.ok) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "url_not_admitted",
        code: urlAdmission.code,
        message: urlAdmission.reason,
        status: 400,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    const urlEngineBacked = urlAdmission.engineBacked

    // Browser-local tools never enter this route. An engine-backed remote
    // review does, so require one current workspace proof before the engine
    // sends its first request. DNS proof is deliberately reusable for the
    // domain rather than creating an approval chore for every scan.
    // The gate follows the SPONSOR's effective plan — workspace.plan is a
    // display field under account-owned billing and must never decide this.
    if (target.type === "WEB_APP" || target.type === "API") {
      const sponsorPlan = await resolveSponsorScanPlan(workspaceId, session.userId)
      if (sponsorPlan === "FREE" && !urlEngineBacked) {
        // Free tier's deterministic surface review could otherwise be used to
        // drive server-side fetches of arbitrary third-party sites. Bound it
        // per client IP; Turnstile is the follow-up.
        const freeUrlLimit = await checkFreeUrlScanRateLimit(clientIpFromRequest(request))
        if (freeUrlLimit.limited) {
          return refuseScan({
            workspaceId,
            actorUserId,
            reason: "free_scan_rate_limited",
            code: "FREE_URL_SCAN_RATE_LIMITED",
            message:
              "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews.",
            status: 429,
            headers: { "Retry-After": String(Math.max(freeUrlLimit.retryAfter, 1)) },
            targetId: data.targetId,
            mode: data.mode,
            workflow: data.workflow,
          })
        }
      }
      if (sponsorPlan !== "FREE" && urlEngineBacked) {
        const { domain, verified } = await findCurrentDomainProof(workspaceId, target.url)
        if (!verified) {
          return refuseScan({
            workspaceId,
            actorUserId,
            reason: "domain_verification_required",
            code: "DOMAIN_VERIFICATION_REQUIRED",
            message: "Verify control of this domain once to enable engine-backed reviews.",
            status: 403,
            details: {
              remediation: {
                txtName: domain ? `_lyrashield.${domain}` : null,
                verifyPath: target.id ? `/dashboard/targets/${target.id}` : null,
              },
            },
            targetId: data.targetId,
            mode: data.mode,
            workflow: data.workflow,
          })
        }
      }
    }

    const canonical = resolveCanonicalReviewMode({ targetType: target.type, mode: data.mode })
    if (!canonical.ok) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "profile_unavailable",
        code: canonical.code,
        message:
          canonical.code === "TARGET_TYPE_UNSUPPORTED"
            ? "This target cannot be reviewed yet."
            : "This review type is not available for the selected target.",
        status: 400,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    const canonicalMode = canonical.canonicalMode

    // ─── Billing entitlement gate (Sprint 10, account-owned) ────────────
    // The sponsoring account pays: the caller's subscription/balance is
    // evaluated, not this workspace's billing row. Block DEEP/CUSTOM on
    // TRIAL/STARTER plans; check usage balance; enforce trial throttle.
    const entitlement = await assertScanAllowed(workspaceId, canonicalMode, session.userId)
    if (!entitlement.allowed) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "entitlement_denied",
        code: entitlement.code ?? "SCAN_NOT_ALLOWED",
        message: entitlement.message ?? "Scan not allowed",
        status: 403,
        details: {
          plan: entitlement.plan,
          isTrial: entitlement.isTrial,
          remainingMinutes: entitlement.remainingMinutes,
        },
        targetId: data.targetId,
        mode: canonicalMode,
        workflow: data.workflow,
      })
    }

    const policy = await findScanPolicy(workspaceId, data.policyId)
    if (data.policyId && !policy) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "policy_not_found",
        code: "POLICY_NOT_FOUND",
        message: "Policy not found in this workspace",
        status: 404,
        targetId: data.targetId,
        mode: canonicalMode,
        workflow: data.workflow,
      })
    }
    const policyId = policy?.id

    // W3-01: durable operation identity is opt-in. Callers that send an
    // Idempotency-Key get identical-retry replay semantics; without the
    // header the route behaves exactly as before.
    const idempotencyKey = request.headers.get("idempotency-key")?.trim()
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
        return apiError("VALIDATION_ERROR", "Idempotency-Key must be 1-128 characters", 400)
      }
      const claim = await claimOrGetAgentOperation({
        workspaceId,
        operationName: "scan.create",
        idempotencyKey,
        input: { ...data, mode: canonicalMode, policyId: policyId ?? null },
        connectionId: session.oauth?.connectionId,
        authorizationVersion: session.oauth?.authorizationVersion,
        apiKeyId: session.apiKey?.keyId,
        userId: session.apiKey || session.oauth ? undefined : session.userId,
      })
      if (claim.status === "CONFLICT") {
        return apiError("IDEMPOTENCY_CONFLICT", claim.message, 409)
      }
      if (claim.status === "REPLAY") {
        if (!claim.operation.result || !claim.operation.resultReference) {
          return apiError(
            "OPERATION_RESULT_UNAVAILABLE",
            "The recorded scan cannot be replayed. Inspect its operation status.",
            409,
            undefined,
            { operationId: claim.operation.id }
          )
        }
        return apiSuccess(
          {
            ...(claim.operation.result as Record<string, unknown>),
            operationId: claim.operation.id,
          },
          200
        )
      }
      if (claim.status === "FAILED") {
        return apiError(
          "OPERATION_FAILED",
          "This operation previously failed. Inspect its status before starting another scan.",
          409,
          undefined,
          { operationId: claim.operation.id }
        )
      }
      if (claim.status === "IN_PROGRESS") {
        return apiError(
          "OPERATION_IN_PROGRESS",
          "An identical scan start is already in progress. Poll the operation status instead of retrying.",
          409,
          undefined,
          { operationId: claim.operation.id }
        )
      }
      operationClaim = claim
    }

    // Spend controls, cheapest check first. The existing per-target guard below stops the
    // same target running twice; neither of these bounded a workspace fanning out across
    // many targets, where each scan can commit up to PLATFORM_MAX_SCAN_BUDGET_USD.
    const scanRate = await checkScanCreateRateLimit(workspaceId)
    if (scanRate.limited) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "rate_limited",
        code: "SCAN_RATE_LIMITED",
        message: "Too many reviews started in the last minute. Please wait a moment and try again.",
        status: 429,
        headers: { "Retry-After": String(Math.max(scanRate.retryAfter, 1)) },
        targetId: data.targetId,
        mode: canonicalMode,
        workflow: data.workflow,
      })
    }

    try {
      await assertScanWorkerAvailable()
    } catch (error) {
      if (error instanceof ScanWorkerUnavailableError) {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "worker_unavailable",
          code: "SCAN_SERVICE_UNAVAILABLE",
          message: "Scanning is temporarily unavailable. Please try again shortly.",
          status: 503,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      throw error
    }

    // Resolve repository refs through the authorized source integration BEFORE
    // createScan takes the short DB admission lock, so the stored execution
    // plan records immutable object IDs — never moving refs. Clients supply
    // workflow intent only; the server owns the plan.
    let planSource:
      { revision: string; baseRevision?: string; mergeBaseRevision?: string } | undefined
    if (data.workflow === "AUTHENTICATED_ASSESSMENT") {
      // Gated staging beta — fail closed at every layer. BOTH the environment
      // flag and the explicit per-workspace/target allowlist must admit this
      // pair; absence of either keeps the workflow unavailable.
      const betaAdmission = authAssessmentAdmission(workspaceId, data.targetId)
      if (!betaAdmission.allowed) {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "workflow_unavailable",
          code: "SCAN_WORKFLOW_UNAVAILABLE",
          message: "Authenticated assessment is not enabled for this workspace and target.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      if (target.type !== "WEB_APP" && target.type !== "API") {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "plan_invalid",
          code: "SCAN_PLAN_INVALID",
          message: "Authenticated assessment requires a live web app or API target.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      // The beta never runs under a destructive-allowed policy.
      if (policy?.destructiveTestsAllowed === true) {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "plan_denied",
          code: "SCAN_PLAN_DENIED",
          message:
            "The selected policy allows destructive tests, which the authenticated assessment forbids.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      // The authorization reference must name a recorded, scoped artifact —
      // verified staging consent, current domain proof, incident contact, and
      // a bound short-lived test-session credential — covering this exact
      // target host. The worker re-verifies all of it at execution time.
      if (!data.authorizationRef) {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "authorization_required",
          code: "SCAN_AUTHORIZATION_REQUIRED",
          message: "Authenticated assessment requires a recorded scoped authorization reference.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      try {
        await resolveAuthenticatedAssessmentAuthorization({
          workspaceId,
          targetId: data.targetId,
          authorizationRef: data.authorizationRef,
        })
      } catch (authErr) {
        if (authErr instanceof LiveAiSafetyError) {
          return refuseScan({
            workspaceId,
            actorUserId,
            reason: "authorization_denied",
            code: authErr.code,
            message: "The recorded assessment authorization does not cover this target.",
            status: authErr.code === "AUTH_ASSESSMENT_PRODUCTION_DENIED" ? 403 : 400,
            targetId: data.targetId,
            mode: canonicalMode,
            workflow: data.workflow,
          })
        }
        throw authErr
      }
    }
    if (data.workflow === "REVIEW_CHANGES") {
      if (target.type !== "REPO") {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "plan_invalid",
          code: "SCAN_PLAN_INVALID",
          message: "Review Changes requires a repository target.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      const installationId = target.installationId ? Number(target.installationId) : null
      const repoOwner = target.repoOwner ?? target.repoFullName?.split("/")[0]
      const repoName = target.repoName ?? target.repoFullName?.split("/")[1]
      if (!installationId || !repoOwner || !repoName) {
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "source_unavailable",
          code: "SCAN_SOURCE_UNAVAILABLE",
          message: "Review Changes requires a repository connected through the GitHub App.",
          status: 409,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
      try {
        const headSha = await resolveRepoRevision(
          installationId,
          repoOwner,
          repoName,
          data.headRef ??
            target.branch ??
            (await getDefaultBranch(installationId, repoOwner, repoName))
        )
        const baseSha = await resolveRepoRevision(
          installationId,
          repoOwner,
          repoName,
          data.baseRef!
        )
        const mergeBaseSha = await getMergeBaseSha(
          installationId,
          repoOwner,
          repoName,
          baseSha,
          headSha
        )
        if (!mergeBaseSha) {
          return refuseScan({
            workspaceId,
            actorUserId,
            reason: "merge_base_missing",
            code: "SCAN_NO_MERGE_BASE",
            message: "The selected refs have no common merge base.",
            status: 409,
            targetId: data.targetId,
            mode: canonicalMode,
            workflow: data.workflow,
          })
        }
        planSource = {
          revision: headSha,
          baseRevision: baseSha,
          mergeBaseRevision: mergeBaseSha,
        }
      } catch (resolveErr) {
        logger.warn("Failed to resolve Review Changes refs", {
          workspaceId,
          targetId: data.targetId,
          error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        })
        return refuseScan({
          workspaceId,
          actorUserId,
          reason: "ref_unresolved",
          code: "SCAN_REF_UNRESOLVED",
          message: "Could not resolve the requested refs to immutable revisions.",
          status: 400,
          targetId: data.targetId,
          mode: canonicalMode,
          workflow: data.workflow,
        })
      }
    } else if (target.type === "REPO" && target.installationId) {
      // Pin the head revision when the authorized integration can resolve it.
      // REVIEW_TARGET keeps provenance honestly absent when the repository is
      // unreachable rather than failing scan admission on a resolver outage.
      const installationId = Number(target.installationId)
      const repoOwner = target.repoOwner ?? target.repoFullName?.split("/")[0]
      const repoName = target.repoName ?? target.repoFullName?.split("/")[1]
      if (repoOwner && repoName) {
        try {
          const branch =
            target.branch ?? (await getDefaultBranch(installationId, repoOwner, repoName))
          planSource = {
            revision: await resolveRepoRevision(installationId, repoOwner, repoName, branch),
          }
        } catch (resolveErr) {
          logger.warn("Head revision resolution failed; plan records no source pin", {
            workspaceId,
            targetId: data.targetId,
            error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          })
        }
      }
    }

    submissionAttempted = true
    const scan = await createScan({
      workspaceId,
      targetId: data.targetId,
      goal: data.goal,
      mode: canonicalMode,
      policyId,
      createdById: session.userId,
      // W0.4 — bind the delegated grant that just passed assertOAuthDelegatedScope
      // into the durable scan record, so the async execution boundary re-verifies
      // the exact connection/version instead of inheriting the request-time allow.
      ...(session.oauth?.connectionId && session.oauth.authorizationVersion
        ? {
            delegatedConnection: {
              connectionId: session.oauth.connectionId,
              authorizationVersion: session.oauth.authorizationVersion,
            },
          }
        : {}),
      workflow: data.workflow,
      ...(planSource ? { source: planSource } : {}),
      // Verified above for AUTHENTICATED_ASSESSMENT; the schema rejects it on
      // every other workflow, so this only ever carries a checked reference.
      ...(data.authorizationRef ? { authorizationRef: data.authorizationRef } : {}),
      // Recorded verbatim into the immutable plan as input-evidence
      // references — the deduped, scope/checksum-validated list resolved
      // above. This API never treats the list as proof of staged input.
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })

    submittedScanId = scan.id
    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId,
        targetId: data.targetId,
        goal: data.goal,
        mode: canonicalMode,
        policyId,
        focus: data.focus,
      })
    } catch (enqueueErr) {
      logger.error("Failed to enqueue scan job", {
        scanId: scan.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      })
      await updateScanStatus(scan.id, "FAILED", {
        errorCategory: "QUEUE",
        errorMessage: "Scan worker became unavailable while queueing the scan",
      })
      revalidateDashboardAggregates(workspaceId)
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "enqueue_failed",
        code: "SCAN_SERVICE_UNAVAILABLE",
        message: "Scanning became unavailable while starting this scan. Please try again shortly.",
        status: 503,
        targetId: data.targetId,
        mode: canonicalMode,
        workflow: data.workflow,
      })
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "scan.created",
        resourceType: "scan",
        resourceId: scan.id,
      },
    })

    logger.info("Scan created and enqueued", {
      scanId: scan.id,
      workspaceId,
      targetId: data.targetId,
    })

    revalidateDashboardAggregates(workspaceId)

    // Return the same shape the list endpoint returns. The client prepends this
    // straight into its scan list and validates it against the list-item schema,
    // so a narrower payload here fails response validation and surfaces to the
    // user as "Start scan" erroring — on a scan that was in fact created
    // and enqueued. `target` is the row already loaded and authorised above, and
    // findingCount is 0 by construction for a scan that has not run yet.
    const result = {
      ...serializeScanListItem({
        id: scan.id,
        status: scan.status,
        goal: scan.goal,
        mode: scan.mode,
        triggerType: scan.triggerType,
        startedAt: scan.startedAt,
        endedAt: scan.endedAt,
        durationMs: scan.durationMs,
        summary: scan.summary,
        errorCategory: scan.errorCategory,
        errorMessage: scan.errorMessage,
        createdAt: scan.createdAt,
        findingCount: 0,
        target: {
          id: target.id,
          name: target.name,
          type: target.type,
          url: target.url,
          apiSpecUrl: target.apiSpecUrl,
          repoFullName: target.repoFullName,
        },
      }),
      // The server-owned immutable plan recorded at creation and its content
      // digest — the provenance contract every client (SDK/CLI/MCP/Action/
      // Desktop) reads on a recorded scan. GET /api/scans/[id] returns the
      // same fields from the stored row.
      executionPlan: scan.executionPlan ?? null,
      executionPlanHash: scan.executionPlanHash ?? null,
    }
    if (operationClaim?.status === "NEW") {
      await completeAgentOperation(operationClaim.operation.id, workspaceId, {
        resultReference: scan.id,
        result: toJsonObject(result),
      })
      operationCompleted = true
    }
    return apiSuccess(
      {
        ...result,
        ...(operationClaim?.status === "NEW" ? { operationId: operationClaim.operation.id } : {}),
      },
      201
    )
  } catch (error) {
    if (error instanceof WorkspaceScanConcurrencyLimitError) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "concurrency_limit",
        code: "SCAN_CONCURRENCY_LIMIT",
        message: `This workspace already has ${MAX_CONCURRENT_WORKSPACE_SCANS} reviews running. Wait for one to finish before starting another.`,
        status: 409,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    if (
      (error && typeof error === "object" && (error as { code?: string }).code === "P2002") ||
      (error instanceof Error && error.message === "Target already has an active scan")
    ) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "scan_in_progress",
        code: "SCAN_IN_PROGRESS",
        message: "Target already has an active scan. Cancel it or wait for completion.",
        status: 409,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    if (error instanceof Error && error.message === "Target not found in this workspace") {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "target_not_found",
        code: "TARGET_NOT_FOUND",
        message: "Target not found in this workspace",
        status: 404,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    if (error instanceof ScanExecutionPlanInputError) {
      return refuseScan({
        workspaceId,
        actorUserId,
        reason: "plan_invalid",
        code: "SCAN_PLAN_INVALID",
        message: error.message,
        status: 400,
        targetId: data.targetId,
        mode: data.mode,
        workflow: data.workflow,
      })
    }
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create scan", 500)
  } finally {
    if (operationClaim?.status === "NEW" && !operationCompleted) {
      const operationId = operationClaim.operation.id
      await failAgentOperation(operationId, workspaceId, {
        error: submissionAttempted ? "OPERATION_OUTCOME_UNKNOWN" : "OPERATION_NOT_SUBMITTED",
        resultReference: submittedScanId,
      }).catch((error) =>
        logger.error("Failed to record scan operation outcome", {
          operationId,
          error: String(error),
        })
      )
    }
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const rawStatus = searchParams.get("status")
    const rawScanIds = searchParams.get("ids")
    // URL-backed state filter (ALL | ACTIVE | COMPLETED | NEEDS_ATTENTION |
    // CANCELLED). Composes with, but never replaces, the legacy status param.
    const stateFilter = parseScanStateFilter(searchParams.get("state"))

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    let scanIds: string[] | undefined
    if (rawScanIds !== null) {
      const parsed = ScanIdQuerySchema.safeParse(rawScanIds.split(",").map((id) => id.trim()))
      if (!parsed.success) {
        return apiError(
          "INVALID_PARAM",
          `ids must contain 1-${MAX_CONCURRENT_WORKSPACE_SCANS} valid scan IDs`,
          400
        )
      }
      scanIds = parsed.data
    }

    // Support a single status value or a comma-separated list of statuses.
    let statusFilter: Parameters<typeof listScans>[0]["statuses"] | undefined
    let singleStatus: Parameters<typeof listScans>[0]["status"] | undefined
    if (rawStatus) {
      const parts = rawStatus
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length > 1) {
        const parsed = parts.map((s) => ScanStatusSchema.safeParse(s))
        const invalid = parsed.find((r) => !r.success)
        if (invalid) {
          return apiError("INVALID_PARAM", "status contains an invalid scan status value", 400)
        }
        statusFilter = parsed.map((r) => (r as { success: true; data: typeof singleStatus }).data!)
      } else {
        const parsed = ScanStatusSchema.safeParse(parts[0])
        if (!parsed.success) {
          return apiError("INVALID_PARAM", "status must be a valid scan status", 400)
        }
        singleStatus = parsed.data
      }
    }

    await requirePermission(workspaceId, PERMISSIONS.scan.view)

    const { cursor, limit } = parsePaginationParams(searchParams, 25)

    // Intersect the state filter with an explicit legacy status filter so both
    // contracts stay meaningful when combined.
    const stateStatuses = scanStateStatuses(stateFilter)
    const explicitStatuses = statusFilter ?? (singleStatus ? [singleStatus] : undefined)
    let effectiveStatuses: string[] | undefined
    if (stateStatuses && explicitStatuses) {
      effectiveStatuses = explicitStatuses.filter((status) => stateStatuses.includes(status))
      if (effectiveStatuses.length === 0) {
        return NextResponse.json(
          { success: true, data: { items: [], nextCursor: null } },
          { status: 200, headers: { "Cache-Control": "private, no-store" } }
        )
      }
    } else if (stateStatuses) {
      effectiveStatuses = stateStatuses
    }

    const { items, nextCursor } = await listScans({
      workspaceId,
      ...(scanIds ? { scanIds } : {}),
      ...(targetId ? { targetId } : {}),
      ...(effectiveStatuses
        ? { statuses: effectiveStatuses as Parameters<typeof listScans>[0]["statuses"] }
        : statusFilter
          ? { statuses: statusFilter }
          : singleStatus
            ? { status: singleStatus }
            : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    const serialized = items.map(serializeScanListItem)
    const etag = scanListEtag(serialized, nextCursor)
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    return NextResponse.json(
      { success: true, data: { items: serialized, nextCursor } },
      { status: 200, headers: { ETag: etag } }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list scans", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list scans", 500)
  }
}

export const POST = withCookieMutation(post)
