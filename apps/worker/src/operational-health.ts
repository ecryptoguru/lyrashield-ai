import { getSystemPrisma } from "@lyrashield/db"

export const TERMINAL_COST_DISPOSITION_STAGE = "terminal_cost_operator_reconciled"
export const TERMINAL_COST_DISPOSITION_RECEIPT_TYPE = "terminal_cost_operator_disposition_v1"

export const OPERATIONAL_ALERT_THRESHOLDS = {
  readinessFailureMs: 5 * 60_000,
  queueDepthMultiplier: 2,
  queueDepthSustainedMs: 10 * 60_000,
  oldestWaitingJobMs: 5 * 60_000,
  terminalUnreconciledCostMs: 15 * 60_000,
  workerCpuPercent: 85,
} as const

export type OperationalAlertCode =
  | "scan_readiness_unavailable"
  | "scan_worker_lease_expired"
  | "scan_queue_depth_high"
  | "scan_queue_oldest_wait_high"
  | "reconciliation_drift"
  | "webhook_dead_letter"
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
  evidenceFailureCount?: number
  oldestTerminalUnreconciledCostAgeMs?: number
  activeReplicaCount?: number
  replicaRestartCount?: number
  workerCpuPercent?: number
}

export interface OperationalAlertState {
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

const TERMINAL_SCAN_STATUSES = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
] as const
const EVIDENCE_FAILURE_WINDOW_MS = 10 * 60_000

let queueDepthExceededSinceMs: number | null = null

export function resetOperationalHealthState(): void {
  queueDepthExceededSinceMs = null
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
  const terminalCostCutoff = new Date(
    now.getTime() - OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs
  )
  const [webhookDeadLetterCount, oldestUnreconciled, evidenceFailureCount] = await Promise.all([
    prisma.webhookEventTrack.count({ where: { status: "dead_letter" } }),
    prisma.scan.findFirst({
      where: {
        status: { in: [...TERMINAL_SCAN_STATUSES] },
        endedAt: { lt: terminalCostCutoff },
        deletedAt: null,
        target: { type: "REPO" },
        billedCostUsd: null,
        OR: [
          { providerCostUsd: { not: null } },
          { events: { some: { stage: "llm_usage_unavailable", deletedAt: null } } },
        ],
        events: {
          none: {
            stage: TERMINAL_COST_DISPOSITION_STAGE,
            deletedAt: null,
            AND: [
              {
                metadata: {
                  path: ["receiptType"],
                  equals: TERMINAL_COST_DISPOSITION_RECEIPT_TYPE,
                },
              },
              {
                metadata: {
                  path: ["conclusion", "providerCostUsd"],
                  equals: "0.000000",
                },
              },
            ],
          },
        },
      },
      select: { endedAt: true },
      orderBy: { endedAt: "asc" },
    }),
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
    evidenceFailureCount,
    oldestTerminalUnreconciledCostAgeMs: oldestUnreconciled?.endedAt
      ? now.getTime() - oldestUnreconciled.endedAt.getTime()
      : 0,
  }
}
