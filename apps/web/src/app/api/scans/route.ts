import { createHash } from "crypto"
import {
  prisma,
  createScan,
  listScans,
  updateScanStatus,
  WorkspaceScanConcurrencyLimitError,
  type ScanListItem,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  CreateScanSchema,
  MAX_CONCURRENT_WORKSPACE_SCANS,
  ScanStatusSchema,
  resolveScanProfile,
  resolveTargetScanMode,
} from "@lyrashield/types"
import { normalizeDomainForProof } from "@lyrashield/security"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { z } from "zod"
import { assertScanAllowed } from "@lyrashield/billing"
import { revalidateDashboardAggregates } from "../../../lib/cache"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, parsePaginationParams } from "../../../lib/api-response"
import {
  assertScanWorkerAvailable,
  enqueueScanJob,
  ScanWorkerUnavailableError,
} from "../../../lib/queue"
import {
  checkFreeUrlScanRateLimit,
  checkScanCreateRateLimit,
  clientIpFromRequest,
} from "../../../lib/rate-limit"

const ACTIVE_SCAN_STATUSES = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"] as const
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

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = CreateScanSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const data = parsed.data
  const workspaceId = data.workspaceId

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)

    const target = await prisma.target.findFirst({
      where: { id: data.targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    // Browser-local tools never enter this route. A paid remote review does,
    // so require one current workspace proof before the first server-side
    // request. DNS proof is deliberately reusable for the domain rather than
    // creating an approval chore for every scan.
    if (target.type === "WEB_APP" || target.type === "API") {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      })
      if (!workspace || workspace.plan === "FREE") {
        // Free tier skips domain verification, so a free account could
        // otherwise drive server-side reviews of arbitrary third-party
        // sites. Bound it per client IP; Turnstile is the follow-up.
        const freeUrlLimit = await checkFreeUrlScanRateLimit(clientIpFromRequest(request))
        if (freeUrlLimit.limited) {
          return apiError(
            "FREE_URL_SCAN_RATE_LIMITED",
            "Free-plan remote URL reviews are temporarily limited for your network. Verify the domain or upgrade for unrestricted reviews.",
            429,
            { "Retry-After": String(Math.max(freeUrlLimit.retryAfter, 1)) }
          )
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
          return apiError(
            "DOMAIN_VERIFICATION_REQUIRED",
            "Verify control of this domain once before starting a paid remote review.",
            403
          )
        }
      }
    }

    if (target.type === "WEB_APP" || target.type === "API") {
      const resolved = resolveTargetScanMode({
        targetType: target.type,
        mode: data.mode,
        hasApiSpec: Boolean((target as { apiSpecUrl?: string | null }).apiSpecUrl),
      })
      if (!resolved.ok) {
        return apiError(resolved.code, resolved.reason, 400)
      }
    }

    let canonicalMode = data.mode
    if (target.type === "REPO" || target.type === "WEB_APP" || target.type === "API") {
      try {
        canonicalMode = resolveScanProfile({
          targetType: target.type,
          mode: data.mode,
        }).canonicalMode
      } catch (error) {
        const code = error instanceof Error ? error.message : "TARGET_TYPE_UNSUPPORTED"
        return apiError(code, "This review type is not available for the selected target.", 400)
      }
    } else if (target.type) {
      return apiError("TARGET_TYPE_UNSUPPORTED", "This target cannot be reviewed yet.", 400)
    }

    // ─── Billing entitlement gate (Sprint 10) ───────────────────────────
    // Block DEEP/CUSTOM scans on TRIAL and STARTER plans; check usage balance;
    // enforce trial scan-frequency throttle.
    const entitlement = await assertScanAllowed(workspaceId, canonicalMode)
    if (!entitlement.allowed) {
      return apiError(
        entitlement.code ?? "SCAN_NOT_ALLOWED",
        entitlement.message ?? "Scan not allowed",
        403,
        undefined,
        {
          plan: entitlement.plan,
          isTrial: entitlement.isTrial,
          remainingMinutes: entitlement.remainingMinutes,
        }
      )
    }

    const policy = await prisma.policy.findFirst({
      where: data.policyId
        ? { id: data.policyId, workspaceId, deletedAt: null }
        : { workspaceId, name: "Default Policy", deletedAt: null },
      orderBy: data.policyId ? undefined : { createdAt: "asc" },
      select: { id: true },
    })
    if (data.policyId && !policy) {
      return apiError("POLICY_NOT_FOUND", "Policy not found in this workspace", 404)
    }
    const policyId = policy?.id

    // Spend controls, cheapest check first. The existing per-target guard below stops the
    // same target running twice; neither of these bounded a workspace fanning out across
    // many targets, where each scan can commit up to PLATFORM_MAX_SCAN_BUDGET_USD.
    const scanRate = await checkScanCreateRateLimit(workspaceId)
    if (scanRate.limited) {
      return apiError(
        "SCAN_RATE_LIMITED",
        "Too many reviews started in the last minute. Please wait a moment and try again.",
        429,
        { "Retry-After": String(Math.max(scanRate.retryAfter, 1)) }
      )
    }

    const [activeScans, activeWorkspaceScans] = await Promise.all([
      prisma.scan.count({
        where: {
          workspaceId,
          targetId: data.targetId,
          status: { in: [...ACTIVE_SCAN_STATUSES] },
        },
      }),
      prisma.scan.count({
        where: { workspaceId, status: { in: [...ACTIVE_SCAN_STATUSES] } },
      }),
    ])
    if (activeScans > 0) {
      return apiError(
        "SCAN_IN_PROGRESS",
        "Target already has an active scan. Cancel it or wait for completion.",
        409
      )
    }
    if (activeWorkspaceScans >= MAX_CONCURRENT_WORKSPACE_SCANS) {
      return apiError(
        "SCAN_CONCURRENCY_LIMIT",
        `This workspace already has ${activeWorkspaceScans} reviews running. Wait for one to finish before starting another.`,
        409
      )
    }

    try {
      await assertScanWorkerAvailable()
    } catch (error) {
      if (error instanceof ScanWorkerUnavailableError) {
        return apiError(
          "SCAN_SERVICE_UNAVAILABLE",
          "Scanning is temporarily unavailable. Please try again shortly.",
          503
        )
      }
      throw error
    }

    const scan = await createScan({
      workspaceId,
      targetId: data.targetId,
      goal: data.goal,
      mode: canonicalMode,
      policyId,
      createdById: session.userId,
    })

    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId,
        targetId: data.targetId,
        goal: data.goal,
        mode: canonicalMode,
        policyId,
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
      revalidateDashboardAggregates()
      return apiError(
        "SCAN_SERVICE_UNAVAILABLE",
        "Scanning became unavailable while starting this scan. Please try again shortly.",
        503
      )
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

    revalidateDashboardAggregates()

    // Return the same shape the list endpoint returns. The client prepends this
    // straight into its scan list and validates it against the list-item schema,
    // so a narrower payload here fails response validation and surfaces to the
    // user as "Start Trust Run" erroring — on a scan that was in fact created
    // and enqueued. `target` is the row already loaded and authorised above, and
    // findingCount is 0 by construction for a scan that has not run yet.
    return apiSuccess(
      serializeScanListItem({
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
      201
    )
  } catch (error) {
    if (error instanceof WorkspaceScanConcurrencyLimitError) {
      return apiError(
        "SCAN_CONCURRENCY_LIMIT",
        `This workspace already has ${MAX_CONCURRENT_WORKSPACE_SCANS} reviews running. Wait for one to finish before starting another.`,
        409
      )
    }
    if (
      (error && typeof error === "object" && (error as { code?: string }).code === "P2002") ||
      (error instanceof Error && error.message === "Target already has an active scan")
    ) {
      return apiError(
        "SCAN_IN_PROGRESS",
        "Target already has an active scan. Cancel it or wait for completion.",
        409
      )
    }
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create scan", 500)
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const rawStatus = searchParams.get("status")
    const rawScanIds = searchParams.get("ids")

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

    const { cursor, limit } = parsePaginationParams(searchParams)

    const { items, nextCursor } = await listScans({
      workspaceId,
      ...(scanIds ? { scanIds } : {}),
      ...(targetId ? { targetId } : {}),
      ...(statusFilter ? { statuses: statusFilter } : singleStatus ? { status: singleStatus } : {}),
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
