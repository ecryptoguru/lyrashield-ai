import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  countDeadLetterArtifactDeletionTasks: vi.fn(),
  prisma: {
    webhookEventTrack: { count: vi.fn() },
    scan: { findFirst: vi.fn(), count: vi.fn() },
  },
}))

vi.mock("@lyrashield/db", () => ({
  countDeadLetterArtifactDeletionTasks: mocks.countDeadLetterArtifactDeletionTasks,
  getSystemPrisma: () => mocks.prisma,
}))

import {
  collectOperationalHealthSnapshot,
  evaluateOperationalHealth,
  OPERATIONAL_ALERT_THRESHOLDS,
  resetOperationalHealthState,
  type OperationalHealthSnapshot,
} from "./operational-health"

const healthy: OperationalHealthSnapshot = {
  readinessFailureAgeMs: 0,
  expiredLeaseCount: 0,
  queueDepth: 0,
  workerConcurrency: 1,
  queueDepthExceededAgeMs: 0,
  oldestWaitingJobAgeMs: 0,
  reconciliationDriftCount: 0,
  webhookDeadLetterCount: 0,
  artifactDeletionDeadLetterCount: 0,
  evidenceFailureCount: 0,
  oldestTerminalUnreconciledCostAgeMs: 0,
  activeReplicaCount: 1,
  replicaRestartCount: 0,
  workerCpuPercent: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  resetOperationalHealthState()
  mocks.prisma.webhookEventTrack.count.mockResolvedValue(0)
  mocks.countDeadLetterArtifactDeletionTasks.mockResolvedValue(0)
  mocks.prisma.scan.findFirst.mockResolvedValue(null)
  mocks.prisma.scan.count.mockResolvedValue(0)
})

describe("evaluateOperationalHealth", () => {
  it("does not alert at strict duration and percentage boundaries", () => {
    expect(
      evaluateOperationalHealth({
        ...healthy,
        readinessFailureAgeMs: OPERATIONAL_ALERT_THRESHOLDS.readinessFailureMs,
        queueDepth: 2,
        queueDepthExceededAgeMs: OPERATIONAL_ALERT_THRESHOLDS.queueDepthSustainedMs,
        oldestWaitingJobAgeMs: OPERATIONAL_ALERT_THRESHOLDS.oldestWaitingJobMs,
        oldestTerminalUnreconciledCostAgeMs:
          OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs,
        workerCpuPercent: OPERATIONAL_ALERT_THRESHOLDS.workerCpuPercent,
      })
    ).toEqual([])
  })

  it("requires both excess depth and ten minutes of sustained excess", () => {
    const notSustained = evaluateOperationalHealth({
      ...healthy,
      workerConcurrency: 2,
      queueDepth: 5,
      queueDepthExceededAgeMs: OPERATIONAL_ALERT_THRESHOLDS.queueDepthSustainedMs - 1,
    })
    expect(notSustained).toEqual([])

    const sustained = evaluateOperationalHealth({
      ...healthy,
      workerConcurrency: 2,
      queueDepth: 5,
      queueDepthExceededAgeMs: OPERATIONAL_ALERT_THRESHOLDS.queueDepthSustainedMs,
    })
    expect(sustained.map((alert) => alert.code)).toEqual(["scan_queue_depth_high"])
  })

  it("returns one stable alert code for every breached state", () => {
    const alerts = evaluateOperationalHealth({
      ...healthy,
      readinessFailureAgeMs: OPERATIONAL_ALERT_THRESHOLDS.readinessFailureMs + 1,
      expiredLeaseCount: 1,
      queueDepth: 3,
      queueDepthExceededAgeMs: OPERATIONAL_ALERT_THRESHOLDS.queueDepthSustainedMs,
      oldestWaitingJobAgeMs: OPERATIONAL_ALERT_THRESHOLDS.oldestWaitingJobMs + 1,
      reconciliationDriftCount: 1,
      webhookDeadLetterCount: 1,
      artifactDeletionDeadLetterCount: 1,
      evidenceFailureCount: 1,
      oldestTerminalUnreconciledCostAgeMs:
        OPERATIONAL_ALERT_THRESHOLDS.terminalUnreconciledCostMs + 1,
      activeReplicaCount: 0,
      replicaRestartCount: 1,
      workerCpuPercent: OPERATIONAL_ALERT_THRESHOLDS.workerCpuPercent + 0.1,
    })

    expect(alerts.map((alert) => alert.code)).toEqual([
      "scan_readiness_unavailable",
      "scan_worker_lease_expired",
      "scan_queue_depth_high",
      "scan_queue_oldest_wait_high",
      "reconciliation_drift",
      "webhook_dead_letter",
      "artifact_deletion_dead_letter",
      "evidence_persistence_failure",
      "terminal_cost_unreconciled",
      "app_no_active_replica",
      "app_replica_restart",
      "worker_cpu_high",
    ])
  })
})

describe("collectOperationalHealthSnapshot", () => {
  it("collects durable DLQ, evidence, and terminal cost signals", async () => {
    const now = new Date("2026-08-24T12:00:00Z")
    mocks.prisma.webhookEventTrack.count.mockResolvedValue(2)
    mocks.countDeadLetterArtifactDeletionTasks.mockResolvedValue(3)
    mocks.prisma.scan.findFirst.mockResolvedValue({ endedAt: new Date("2026-08-24T11:40:00Z") })
    mocks.prisma.scan.count.mockResolvedValue(1)

    const snapshot = await collectOperationalHealthSnapshot({
      now,
      queueDepth: 3,
      oldestWaitingJobAgeMs: 360_000,
      workerConcurrency: 1,
      reconciliationDriftCount: 1,
    })

    expect(snapshot).toMatchObject({
      queueDepth: 3,
      oldestWaitingJobAgeMs: 360_000,
      reconciliationDriftCount: 1,
      webhookDeadLetterCount: 2,
      artifactDeletionDeadLetterCount: 3,
      evidenceFailureCount: 1,
      oldestTerminalUnreconciledCostAgeMs: 1_200_000,
    })
    expect(mocks.prisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billedCostUsd: null,
          target: { type: "REPO" },
          events: {
            none: expect.objectContaining({
              stage: "terminal_cost_operator_reconciled",
              AND: expect.arrayContaining([
                {
                  metadata: {
                    path: ["receiptType"],
                    equals: "terminal_cost_operator_disposition_v1",
                  },
                },
                {
                  metadata: {
                    path: ["conclusion", "providerCostUsd"],
                    equals: "0.000000",
                  },
                },
              ]),
            }),
          },
        }),
      })
    )
  })

  it("tracks sustained excess queue depth across collection ticks", async () => {
    const first = await collectOperationalHealthSnapshot({
      now: new Date("2026-08-24T12:00:00Z"),
      queueDepth: 3,
      oldestWaitingJobAgeMs: 0,
      workerConcurrency: 1,
      reconciliationDriftCount: 0,
    })
    const second = await collectOperationalHealthSnapshot({
      now: new Date("2026-08-24T12:10:00Z"),
      queueDepth: 3,
      oldestWaitingJobAgeMs: 0,
      workerConcurrency: 1,
      reconciliationDriftCount: 0,
    })

    expect(first.queueDepthExceededAgeMs).toBe(0)
    expect(second.queueDepthExceededAgeMs).toBe(600_000)
    expect(evaluateOperationalHealth(second).map((alert) => alert.code)).toContain(
      "scan_queue_depth_high"
    )
  })
})
