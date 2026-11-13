import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError } from "./api-response"

/**
 * W2.1 — typed scan-admission refusals.
 *
 * Every path that decides a scan cannot be accepted returns a refusal built by
 * `refuseScan` instead of a bare `apiError`:
 *
 * - `error.details.refusal` carries the closed `ScanRefusalReason` vocabulary,
 *   so API clients can distinguish a deliberate admission refusal from an
 *   infrastructure failure without parsing `code`/message strings.
 * - The reason is persisted first as an AuditLog row (`action: "scan.refused"`)
 *   so the refusal is auditable even when the response is dropped.
 *
 * Persistence is best-effort: a refusal is still returned when the audit write
 * fails, because refusing the scan is always safer than silently accepting it.
 */
export const SCAN_REFUSAL_REASONS = [
  "target_not_found",
  "attachment_rejected",
  "url_not_admitted",
  "free_scan_rate_limited",
  "domain_verification_required",
  "profile_unavailable",
  "entitlement_denied",
  "policy_not_found",
  "rate_limited",
  "worker_unavailable",
  "workflow_unavailable",
  "plan_invalid",
  "plan_denied",
  "authorization_required",
  "authorization_denied",
  "source_unavailable",
  "merge_base_missing",
  "ref_unresolved",
  "concurrency_limit",
  "scan_in_progress",
  "enqueue_failed",
] as const

export type ScanRefusalReason = (typeof SCAN_REFUSAL_REASONS)[number]

export async function refuseScan(params: {
  workspaceId: string
  actorUserId?: string | null
  reason: ScanRefusalReason
  code: string
  message: string
  status: number
  headers?: Record<string, string>
  /** Extra `error.details` fields preserved alongside the refusal marker. */
  details?: Record<string, unknown>
  /** Persisted context — which proposed scan was refused. */
  targetId?: string | null
  mode?: string
  workflow?: string
}): Promise<Response> {
  const { reason, code, message, status, headers, details } = params
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId ?? null,
        action: "scan.refused",
        resourceType: "target",
        resourceId: params.targetId ?? null,
        metadata: {
          refusalReason: reason,
          code,
          message: message.length > 500 ? message.slice(0, 500) : message,
          ...(params.targetId ? { targetId: params.targetId } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
          ...(params.workflow ? { workflow: params.workflow } : {}),
        },
      },
    })
  } catch (auditError) {
    logger.warn("Scan refusal record could not be persisted", {
      workspaceId: params.workspaceId,
      reason,
      code,
      error: auditError instanceof Error ? auditError.message : String(auditError),
    })
  }
  return apiError(code, message, status, headers, { refusal: { reason }, ...details })
}

const DEFINITIVE_POST_SUBMISSION_REFUSALS = new Set<ScanRefusalReason>([
  "concurrency_limit",
  "scan_in_progress",
  "target_not_found",
  "plan_invalid",
])

/** Builds route refusals while keeping durable-operation outcomes in sync. */
export function createScanRefusalContext(request: Pick<Request, "headers">) {
  const submission = { attempted: false }
  const handleRefusal = (params: Parameters<typeof refuseScan>[0]) => {
    if (submission.attempted && DEFINITIVE_POST_SUBMISSION_REFUSALS.has(params.reason)) {
      submission.attempted = false
    }

    return refuseScan({
      ...params,
      details:
        request.headers.has("idempotency-key") && !submission.attempted
          ? { ...(params.details ?? {}), operationOutcome: "OPERATION_NOT_SUBMITTED" }
          : params.details,
    })
  }

  return { submission, refuseScan: handleRefusal }
}
