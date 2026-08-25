import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  cancelScan: vi.fn(),
  createScan: vi.fn(),
  deleteUserAccount: vi.fn(),
  getSystemPrisma: vi.fn(),
  isTerminalScanStatus: vi.fn(),
  prisma: {},
  removeScan: vi.fn(),
  TERMINAL_SCAN_STATUSES: new Set(),
  withWorkspaceRLS: vi.fn(),
}))
vi.mock("@lyrashield/config", () => ({ resolveWorkerExecutionProvenanceFrom: vi.fn() }))
vi.mock("@lyrashield/integrations", () => ({
  closeRedis: vi.fn(),
  getRedis: vi.fn(),
  getWebhookTrackRetryQueue: vi.fn(),
  isScanWorkerAvailable: vi.fn(),
  SCAN_ADMISSION_STOP_KEY: "lyrashield:scan-admission:stopped",
}))
vi.mock("../queue", () => ({ getScanQueue: vi.fn() }))
vi.mock("../queue-reconciliation", () => ({
  QUEUE_ORPHAN_GRACE_MS: 300_000,
  reconcileExactQueuedScanOrphan: vi.fn(),
}))

import {
  assertExactFixtureDeletionPlan,
  parseContainerEnvironment,
  parseQueueOrphanFixtureOptions,
  verifyQueueOrphanFixture,
  type QueueOrphanFixtureDeps,
} from "./verify-queue-orphan-fixture"

const fixture = {
  userId: "user-fixture",
  workspaceId: "workspace-fixture",
  workspaceName: "Queue Orphan Fixture 1",
  targetId: "target-fixture",
  scanId: "scan-fixture",
}

function options() {
  return {
    environment: "production",
    confirmProduction: "I AUTHORIZE LYRASHIELD QUEUE ORPHAN FIXTURE",
  }
}

function deps(overrides: Partial<QueueOrphanFixtureDeps> = {}): QueueOrphanFixtureDeps {
  const provenance = {
    productRevision: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    engineRevision: "c".repeat(40),
  }
  const runtimeBindingFingerprints = {
    database: "database-fingerprint",
    systemDatabase: "system-database-fingerprint",
    redis: "redis-fingerprint",
  }
  return {
    preflight: vi
      .fn()
      .mockResolvedValueOnce({
        admissionStopped: true,
        workerAvailable: false,
        serviceState: "inactive",
        containerRunning: false,
        imageReference: `worker@${provenance.workerImageDigest}`,
        provenance,
        runtimeBindingFingerprints,
        activeScanIds: [],
        enabledScheduleCount: 0,
        queueDepth: 0,
      })
      .mockResolvedValueOnce({
        admissionStopped: true,
        workerAvailable: false,
        serviceState: "inactive",
        containerRunning: false,
        imageReference: `worker@${provenance.workerImageDigest}`,
        provenance,
        runtimeBindingFingerprints,
        activeScanIds: [fixture.scanId],
        enabledScheduleCount: 0,
        queueDepth: 0,
      })
      .mockResolvedValueOnce({
        admissionStopped: true,
        workerAvailable: false,
        serviceState: "inactive",
        containerRunning: false,
        imageReference: `worker@${provenance.workerImageDigest}`,
        provenance,
        runtimeBindingFingerprints,
        activeScanIds: [],
        enabledScheduleCount: 0,
        queueDepth: 0,
      }),
    createFixture: vi.fn(async () => fixture),
    wait: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({
      leaseAcquired: true,
      reconciled: true,
      jobState: "missing",
    })),
    inspectFixture: vi.fn(async () => ({
      status: "FAILED",
      errorCategory: "QUEUE",
      errorMessage: "QUEUE_ORPHANED: active scan has no processable queue job",
      engineStartCount: 0,
      auditCount: 1,
      jobExists: false,
      queueDepth: 0,
    })),
    cleanupFixture: vi.fn(async () => undefined),
    retainAuditReceipt: vi.fn(async () => "platform-audit-receipt"),
    retainCleanupAuditReceipt: vi.fn(async () => "platform-cleanup-audit-receipt"),
    now: vi.fn(() => new Date("2026-08-25T01:00:00.000Z")),
    ...overrides,
  }
}

describe("queue orphan fixture options", () => {
  it("requires production and the exact confirmation phrase", () => {
    expect(() => parseQueueOrphanFixtureOptions({})).toThrow(
      "queue orphan fixture requires --environment production"
    )
    expect(() =>
      parseQueueOrphanFixtureOptions({
        environment: "production",
        "confirm-production": "yes",
      })
    ).toThrow("queue orphan fixture requires the exact --confirm-production phrase")
    expect(
      parseQueueOrphanFixtureOptions({
        environment: "production",
        "confirm-production": "I AUTHORIZE LYRASHIELD QUEUE ORPHAN FIXTURE",
      })
    ).toEqual(options())
  })
})

describe("queue orphan fixture cleanup boundary", () => {
  it("accepts only the exact disposable workspace", () => {
    expect(() =>
      assertExactFixtureDeletionPlan(
        {
          deletable: [{ id: fixture.workspaceId, name: fixture.workspaceName }],
          blocked: [],
          retained: [],
        },
        fixture
      )
    ).not.toThrow()

    expect(() =>
      assertExactFixtureDeletionPlan(
        {
          deletable: [
            { id: fixture.workspaceId, name: fixture.workspaceName },
            { id: "unexpected", name: "Unexpected" },
          ],
          blocked: [],
          retained: [],
        },
        fixture
      )
    ).toThrow("manual cleanup is required")
  })
})

describe("stopped container environment parsing", () => {
  it("preserves every byte after the first equals sign", () => {
    expect(
      parseContainerEnvironment(
        "DATABASE_URL=postgresql://user:secret@db/prod?sslmode=require&options=a=b\nREDIS_URL=rediss://default:key@redis:6380/0\n"
      )
    ).toEqual({
      DATABASE_URL: "postgresql://user:secret@db/prod?sslmode=require&options=a=b",
      REDIS_URL: "rediss://default:key@redis:6380/0",
    })
  })
})

describe("queue orphan fixture", () => {
  it("cannot bypass confirmation through the exported orchestrator", async () => {
    const mocked = deps()

    await expect(
      verifyQueueOrphanFixture({ environment: "production", confirmProduction: "yes" }, mocked)
    ).rejects.toThrow("exact --confirm-production phrase")
    expect(mocked.preflight).not.toHaveBeenCalled()
  })

  it("proves one fail-closed orphan without enqueue or engine execution", async () => {
    const mocked = deps()

    await expect(verifyQueueOrphanFixture(options(), mocked)).resolves.toMatchObject({
      overall: "passed",
      workspaceId: fixture.workspaceId,
      scanId: fixture.scanId,
      reconciliation: {
        reconciled: true,
        jobState: "missing",
      },
      cleanup: "passed",
    })

    expect(mocked.wait).toHaveBeenCalledWith(305_000)
    expect(mocked.preflight).toHaveBeenCalledTimes(3)
    expect(mocked.reconcile).toHaveBeenCalledWith(fixture, expect.any(Date))
    expect(mocked.inspectFixture).toHaveBeenCalledWith(fixture)
    expect(mocked.retainAuditReceipt).toHaveBeenCalledWith(
      fixture,
      expect.any(Object),
      expect.any(Object),
      expect.any(Date)
    )
    expect(mocked.retainCleanupAuditReceipt).toHaveBeenCalledWith(
      fixture,
      "platform-audit-receipt",
      expect.any(Date)
    )
    expect(mocked.cleanupFixture).toHaveBeenCalledOnce()
  })

  it.each([
    ["open admission", { admissionStopped: false }],
    ["running worker", { workerAvailable: true }],
    ["active service", { serviceState: "active" }],
    ["running container", { containerRunning: true }],
    ["active scan", { activeScanIds: ["customer-scan"] }],
    ["enabled schedule", { enabledScheduleCount: 1 }],
    ["queued work", { queueDepth: 1 }],
  ])("fails before fixture creation for %s", async (_label, changed) => {
    const mocked = deps({
      preflight: vi.fn(async () => ({
        admissionStopped: true,
        workerAvailable: false,
        serviceState: "inactive",
        containerRunning: false,
        imageReference: `worker@sha256:${"b".repeat(64)}`,
        provenance: {
          productRevision: "a".repeat(40),
          workerImageDigest: `sha256:${"b".repeat(64)}`,
          engineRevision: "c".repeat(40),
        },
        runtimeBindingFingerprints: {
          database: "database-fingerprint",
          systemDatabase: "system-database-fingerprint",
          redis: "redis-fingerprint",
        },
        activeScanIds: [],
        enabledScheduleCount: 0,
        queueDepth: 0,
        ...changed,
      })),
    })

    await expect(verifyQueueOrphanFixture(options(), mocked)).rejects.toThrow()
    expect(mocked.createFixture).not.toHaveBeenCalled()
    expect(mocked.reconcile).not.toHaveBeenCalled()
  })

  it("cleans up through the safe path when verification fails", async () => {
    const mocked = deps({
      inspectFixture: vi.fn(async () => ({
        status: "QUEUED",
        errorCategory: null,
        errorMessage: null,
        engineStartCount: 0,
        auditCount: 1,
        jobExists: false,
        queueDepth: 0,
      })),
    })

    await expect(verifyQueueOrphanFixture(options(), mocked)).rejects.toThrow(
      "fixture did not fail closed"
    )
    expect(mocked.cleanupFixture).toHaveBeenCalledOnce()
  })

  it("rechecks every global precondition before targeted reconciliation", async () => {
    const base = deps()
    const initial = await base.preflight()
    const mocked = deps({
      preflight: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({ ...initial, activeScanIds: [fixture.scanId, "customer-scan"] }),
    })

    await expect(verifyQueueOrphanFixture(options(), mocked)).rejects.toThrow(
      "unexpected active scans exist"
    )
    expect(mocked.reconcile).not.toHaveBeenCalled()
    expect(mocked.cleanupFixture).toHaveBeenCalledOnce()
  })

  it("fails if targeted reconciliation or final inspection sees queue work", async () => {
    const unreconciled = deps({
      reconcile: vi.fn(async () => ({
        leaseAcquired: true,
        reconciled: false,
        jobState: "waiting",
      })),
    })
    await expect(verifyQueueOrphanFixture(options(), unreconciled)).rejects.toThrow(
      "fixture was not reconciled"
    )

    const jobAppeared = deps({
      inspectFixture: vi.fn(async () => ({
        status: "FAILED",
        errorCategory: "QUEUE",
        errorMessage: "QUEUE_ORPHANED: active scan has no processable queue job",
        engineStartCount: 0,
        auditCount: 1,
        jobExists: true,
        queueDepth: 0,
      })),
    })
    await expect(verifyQueueOrphanFixture(options(), jobAppeared)).rejects.toThrow(
      "queue is not empty after targeted reconciliation"
    )
  })

  it("retries cleanup once when the first cleanup attempt fails", async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockResolvedValueOnce(undefined)
    const mocked = deps({ cleanupFixture: cleanup })

    await expect(verifyQueueOrphanFixture(options(), mocked)).rejects.toThrow(
      "transient cleanup failure"
    )
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
