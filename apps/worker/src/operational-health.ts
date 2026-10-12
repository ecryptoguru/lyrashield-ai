import { countDeadLetterArtifactDeletionTasks, getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export const TERMINAL_COST_DISPOSITION_STAGE = "terminal_cost_operator_reconciled"
export const TERMINAL_COST_DISPOSITION_RECEIPT_TYPE = "terminal_cost_operator_disposition_v1"
export const TERMINAL_FAILED_COST_DISPOSITION_RECEIPT_TYPE =
  "terminal_failed_provider_expense_disposition_v2"

export const OPERATIONAL_ALERT_THRESHOLDS = {
  readinessFailureMs: 5 * 60_000,
  queueDepthMultiplier: 2,
  queueDepthSustainedMs: 10 * 60_000,
  oldestWaitingJobMs: 5 * 60_000,
  terminalUnreconciledCostMs: 15 * 60_000,
  workerCpuPercent: 85,
} as const

type OperationalAlertCode =
  | "scan_readiness_unavailable"
  | "scan_worker_lease_expired"
  | "scan_queue_depth_high"
  | "scan_queue_oldest_wait_high"
  | "reconciliation_drift"
  | "webhook_dead_letter"
  | "artifact_deletion_dead_letter"
  | "evidence_persistence_failure"
  | "terminal_cost_unreconciled"
  | "app_no_active_replica"
  | "app_replica_restart"
  | "worker_cpu_high"

export interface OperationalHealthSnapshot {
  readinessFailureAgeMs?: number
  expiredLeaseCount?: number
  queueDepth?: number
  workerConcurrency?: number
  queueDepthExceededAgeMs?: number
  oldestWaitingJobAgeMs?: number
  reconciliationDriftCount?: number
  webhookDeadLetterCount?: number
  artifactDeletionDeadLetterCount?: number
  evidenceFailureCount?: number
  oldestTerminalUnreconciledCostAgeMs?: number
  activeReplicaCount?: number
  replicaRestartCount?: number
  workerCpuPercent?: number
}

interface OperationalAlertState {
  code: OperationalAlertCode
  value: number
  threshold: number
  severity: 1 | 2
}

export function evaluateOperationalHealth(
  snapshot: OperationalHealthSnapshot
): OperationalAlertState[] {
  const alerts: OperationalAlertState[] = []
  const add = (
    condition: boolean,
    code: OperationalAlertCode,
    value: number,
    threshold: number,
    severity: 1 | 2 = 1
  ) => {
    if (condition) alerts.push({ code, value, threshold, severity })
  }

  add(
    snapshot.readinessFailureAgeMs !== undefined &&
      snapshot.readinessFailureAgeMs > OPERATIONAL_ALERT_THRESHOLDS.readinessFailureMs,
    "scan_readiness_unavailable",
    snapshot.readinessFailureAgeMs ?? 0,
    OPERATIONAL_ALERT_THRESHOLDS.readinessFailureMs
  )
  add(
    snapshot.expiredLeaseCount !== undefined && snapshot.expiredLeaseCount > 0,
    "scan_worker_lease_expired",
    snapshot.expiredLeaseCount ?? 0,
    0
  )

  const queueDepthThreshold =
    OPERATIONAL_ALERT_THRESHOLDS.queueDepthMultiplier * Math.max(1, snapshot.workerConcurrency ?? 1)
  add(
    snapshot.queueDepth !== undefined &&
      snapshot.queueDepth > queueDepthThreshold &&
      (snapshot.queueDepthExceededAgeMs ?? 0) >= OPERATIONAL_ALERT_THRESHOLDS.queueDepthSustainedMs,
    "scan_queue_depth_high",
    snapshot.queueDepth ?? 0,
    queueDepthThreshold,
    2
  )
  add(
    snapshot.oldestWaitingJobAgeMs !== undefined &&
      snapshot.oldestWaitingJobAgeMs > OPERATIONAL_ALERT_THRESHOLDS.oldestWaitingJobMs,
    "scan_queue_oldest_wait_high",
    snapshot.oldestWaitingJobAgeMs ?? 0,
    OPERATIONAL_ALERT_THRESHOLDS.oldestWaitingJobMs,
    2
  )
  add(
    snapshot.reconciliationDriftCount !== undefined && snapshot.reconciliationDriftCount > 0,
    "reconciliation_drift",
    snapshot.reconciliationDriftCount ?? 0,
    0
  )
  add(
    snapshot.webhookDeadLetterCount !== undefined && snapshot.webhookDeadLetterCount > 0,
    "webhook_dead_letter",
    snapshot.webhookDeadLetterCount ?? 0,
    0
  )
  add(
    snapshot.artifactDeletionDeadLetterCount !== undefined &&
      snapshot.artifactDeletionDeadLetterCount > 0,
    "artifact_deletion_dead_letter",
    snapshot.artifactDeletionDeadLetterCount ?? 0,
    0
  )
  add(
    snapshot.evidenceFailureCount !== undefined && snapshot.evidenceFailureCount > 0,
    "evidence_persistence_failure",
    snapshot.evidenceFailureCount ?? 0,
    0
  )
  add(
    snapshot.oldestTerminalUnreconciledCostAgeMs !== undefined &&
      snapshot.oldestTerminalUnreconciledCostAgeMs >
        OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs,
    "terminal_cost_unreconciled",
    snapshot.oldestTerminalUnreconciledCostAgeMs ?? 0,
    OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs
  )
  add(
    snapshot.activeReplicaCount !== undefined && snapshot.activeReplicaCount < 1,
    "app_no_active_replica",
    snapshot.activeReplicaCount ?? 0,
    1
  )
  add(
    snapshot.replicaRestartCount !== undefined && snapshot.replicaRestartCount > 0,
    "app_replica_restart",
    snapshot.replicaRestartCount ?? 0,
    0,
    2
  )
  add(
    snapshot.workerCpuPercent !== undefined &&
      snapshot.workerCpuPercent > OPERATIONAL_ALERT_THRESHOLDS.workerCpuPercent,
    "worker_cpu_high",
    snapshot.workerCpuPercent ?? 0,
    OPERATIONAL_ALERT_THRESHOLDS.workerCpuPercent,
    2
  )

  return alerts
}

const EVIDENCE_FAILURE_WINDOW_MS = 10 * 60_000

let queueDepthExceededSinceMs: number | null = null

export function resetOperationalHealthState(): void {
  queueDepthExceededSinceMs = null
}

export async function findOldestTerminalUnreconciledCost(
  now: Date,
  prisma: Pick<ReturnType<typeof getSystemPrisma>, "$queryRaw"> = getSystemPrisma()
) {
  const cutoff = new Date(now.getTime() - OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs)
  // Positive expense dispositions must bind to the current scan version and
  // an atomic operator audit; an arbitrary event or stale receipt cannot clear it.
  const rows = await prisma.$queryRaw<Array<{ id: string; endedAt: Date }>>`
    SELECT s.id, s."endedAt" FROM "Scan" s
    JOIN "Target" t ON t.id = s."targetId"
    WHERE s.status IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STOPPED_BUDGET', 'TIMED_OUT')
      AND s."endedAt" < ${cutoff} AND s."deletedAt" IS NULL
      AND t.type = 'REPO' AND s."billedCostUsd" IS NULL
      AND (s."providerCostUsd" IS NOT NULL OR EXISTS (
        SELECT 1 FROM "ScanEvent" e WHERE e."scanId" = s.id
          AND e."deletedAt" IS NULL AND e.stage = 'llm_usage_unavailable'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM "ScanEvent" e WHERE e."scanId" = s.id
          AND e."deletedAt" IS NULL AND e.stage = ${TERMINAL_COST_DISPOSITION_STAGE}
          AND (
            (e.metadata #>> '{receiptType}' = ${TERMINAL_COST_DISPOSITION_RECEIPT_TYPE}
              AND (s."providerCostUsd" IS NULL OR s."providerCostUsd" = 0)
              AND e.metadata #> '{conclusion,providerCostUsd}' = to_jsonb('0.000000'::text))
            OR (
              s.status = 'FAILED' AND s."providerCostUsd" > 0
              AND e.metadata #>> '{receiptType}' = ${TERMINAL_FAILED_COST_DISPOSITION_RECEIPT_TYPE}
              AND e.metadata #>> '{conclusion,customerBilling}' = 'non_billable_failed_scan'
              AND e.metadata #>> '{conclusion,providerCostUsd}' = s."providerCostUsd"::text
              AND e.metadata #>> '{expectedState,providerCostUsd}' = s."providerCostUsd"::text
              AND e.metadata #>> '{expectedState,workspaceId}' = s."workspaceId"
              AND e.metadata #>> '{expectedState,updatedAt}' = to_char(s."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          )
          AND EXISTS (
            SELECT 1 FROM "PlatformAdminAudit" a WHERE a."resourceId" = s.id
              AND a."resourceType" = 'scan' AND a."sessionId" = 'offline-terminal-cost-review'
              AND a.action = 'terminal_cost.operator_disposition_recorded'
              AND a."actorUserId" = e.metadata #>> '{operator,userId}'
              AND a.metadata = e.metadata
          )
      )
    ORDER BY s."endedAt" ASC, s.id ASC LIMIT 1
  `
  return rows[0] ?? null
}

export async function collectOperationalHealthSnapshot(params: {
  now: Date
  queueDepth: number
  oldestWaitingJobAgeMs: number
  workerConcurrency: number
  reconciliationDriftCount: number
}): Promise<OperationalHealthSnapshot> {
  const { now, queueDepth, oldestWaitingJobAgeMs, workerConcurrency, reconciliationDriftCount } =
    params
  const queueDepthThreshold =
    OPERATIONAL_ALERT_THRESHOLDS.queueDepthMultiplier * Math.max(1, workerConcurrency)
  if (queueDepth > queueDepthThreshold) {
    queueDepthExceededSinceMs ??= now.getTime()
  } else {
    queueDepthExceededSinceMs = null
  }

  const prisma = getSystemPrisma()
  const [
    webhookDeadLetterCount,
    artifactDeletionDeadLetterCount,
    oldestUnreconciled,
    evidenceFailureCount,
  ] = await Promise.all([
    prisma.webhookEventTrack.count({ where: { status: "dead_letter" } }),
    countDeadLetterArtifactDeletionTasks().catch((error) => {
      logger.warn("Artifact deletion dead-letter count unavailable", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }),
    findOldestTerminalUnreconciledCost(now),
    prisma.scan.count({
      where: {
        status: "FAILED",
        endedAt: { gte: new Date(now.getTime() - EVIDENCE_FAILURE_WINDOW_MS) },
        deletedAt: null,
        errorMessage: "Failed to store evidence",
      },
    }),
  ])

  return {
    queueDepth,
    workerConcurrency,
    queueDepthExceededAgeMs:
      queueDepthExceededSinceMs === null ? 0 : now.getTime() - queueDepthExceededSinceMs,
    oldestWaitingJobAgeMs,
    reconciliationDriftCount,
    webhookDeadLetterCount,
    artifactDeletionDeadLetterCount,
    evidenceFailureCount,
    oldestTerminalUnreconciledCostAgeMs: oldestUnreconciled?.endedAt
      ? now.getTime() - oldestUnreconciled.endedAt.getTime()
      : 0,
  }
}
