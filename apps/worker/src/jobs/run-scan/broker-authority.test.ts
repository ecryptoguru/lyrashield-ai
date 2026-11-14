import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { computeScanExecutionPlanHash } from "@lyrashield/db/src/scan-execution-plan"
import { buildScanQueuePayload } from "@lyrashield/db/src/scan-queue-payload"

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  current: vi.fn(),
  workspace: vi.fn(),
  target: vi.fn(),
  operation: vi.fn(),
  member: vi.fn(),
  connection: vi.fn(),
  entitlement: vi.fn(),
  update: vi.fn(),
  legacy: vi.fn(),
  getJob: vi.fn(),
  provenance: vi.fn(),
}))
vi.mock("../run-scan.job", () => ({ processScanJob: mocks.legacy }))
vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_AUTH_ASSESSMENT_ENABLED: "0", LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST: "" },
  evaluateAuthAssessmentAdmission: () => ({ allowed: false }),
  resolveWorkerExecutionProvenance: mocks.provenance,
}))
vi.mock("@lyrashield/billing", () => ({ evaluateScanEntitlement: mocks.entitlement }))
vi.mock("@lyrashield/integrations", () => ({
  getScanQueue: () => ({ name: "scans", getJob: mocks.getJob }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock("./lifecycle-utils", () => ({ refreshGateVerdictAfterTerminalScan: vi.fn() }))
vi.mock("@lyrashield/db", async () => {
  const plan = await vi.importActual<typeof import("@lyrashield/db/src/scan-execution-plan")>(
    "@lyrashield/db/src/scan-execution-plan"
  )
  const tx = {
    scan: { findFirst: mocks.current },
    workspace: { findFirst: mocks.workspace },
    target: { findFirst: mocks.target },
    scanDispatchOperation: { findFirst: mocks.operation },
  }
  return {
    verifyStoredScanExecutionPlan: plan.verifyStoredScanExecutionPlan,
    getSystemPrisma: () => ({ scan: { findUnique: mocks.scan } }),
    withWorkspaceRLS: (_id: string, work: (value: typeof tx) => unknown) => work(tx),
    runWithWorkspaceContext: (_id: string, work: () => unknown) => work(),
    runWithAccountContext: (_id: string, work: () => unknown) => work(),
    prisma: {
      workspaceMember: { findFirst: mocks.member },
      agentConnection: { findFirst: mocks.connection },
    },
    updateUnclaimedScanStatus: mocks.update,
    CANONICAL_OPERATIONS: { SCAN_CREATE: "scan.create", RETEST_CREATE: "retest.create" },
    resolveAuthenticatedAssessmentAuthorization: vi.fn(),
    LiveAiSafetyError: class extends Error {},
  }
})

import {
  createBrokerWorkerAuthorityAdapter,
  type WorkerBrokerInstallation,
} from "./broker-authority"
import { createWorkerScanJobProcessor, processWorkerScanJob } from "../scan-job-processor"
import {
  legacyWorkerLifecycleEnabled,
  workerAuthorityStartup,
  type WorkerAuthorityMode,
} from "../../worker-authority-startup"

const plan = buildScanExecutionPlan({
  targetType: "REPO",
  mode: "SAFE",
  source: { revision: "a".repeat(40) },
})
const planHash = computeScanExecutionPlanHash(plan)
const data = {
  scanId: "scan-1",
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "SAFE",
  focus: "payments",
} as const
const stored = {
  id: data.scanId,
  workspaceId: data.workspaceId,
  targetId: data.targetId,
  goal: data.goal,
  mode: data.mode,
  policyId: null,
  executionPlan: plan,
  executionPlanHash: planHash,
  determinismMode: null,
  startedAt: null,
  createdById: "user-1",
  sponsorAccountId: "user-1",
  accountingVersion: 2,
  triggerType: "manual",
  delegatedConnectionId: null,
  delegatedAuthorizationVersion: null,
}
const provenance = {
  productRevision: "a".repeat(40),
  workerImageDigest: `sha256:${"b".repeat(64)}`,
  engineRevision: "c".repeat(40),
}

function fixture() {
  const startPaid = vi.fn(),
    startUnmetered = vi.fn()
  const broker = {
    prepare: vi.fn().mockResolvedValue({
      kind: "committed",
      operationId: "op-1",
      state: "PREPARING",
      attemptId: "attempt-1",
      commandId: "cmd-1",
    }),
    consumeSupervisorReceipts: vi.fn().mockResolvedValue({
      operationId: "op-1",
      confirmedSequence: 0,
      receipts: 0,
      dispositions: [],
    }),
    status: vi.fn().mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "QUEUED",
      attemptId: null,
    }),
    stop: vi.fn().mockResolvedValue({
      kind: "committed",
      operationId: "op-1",
      state: "STOPPING",
      attemptId: "attempt-1",
      commandId: "stop-1",
    }),
    reconcile: vi.fn(),
    startPaid,
    startUnmetered,
  }
  const publication = {
    verifyDispatch: vi.fn().mockResolvedValue({
      kind: "published",
      row: {
        operationId: "op-1",
        id: data.scanId,
        workspaceId: data.workspaceId,
        executionPlanHash: planHash,
        requestDigest: "d".repeat(64),
        payloadInputJson: buildScanQueuePayload(stored, data.focus),
      },
    }),
  }
  const installation: WorkerBrokerInstallation = {
    authority: {
      ...provenance,
      qualificationDigest: "e".repeat(64),
      authorityEpochId: "epoch-1",
      workerInstanceId: "worker-1",
      workerGrantId: "grant-1",
      expiresAt: new Date(Date.now() + 60000),
    },
    verifyAuthority: vi.fn().mockResolvedValue(true),
    broker,
    publication,
  }
  const processor = createWorkerScanJobProcessor({
    kind: "broker",
    adapter: createBrokerWorkerAuthorityAdapter(installation),
  })
  const job = Object.assign(Object.create(null), {
    id: data.scanId,
    data: { ...data },
  }) as Parameters<typeof processor>[0]
  return { installation, broker, publication, processor, job }
}

function barrier() {
  let release: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release: () => release() }
}

describe("broker worker boundary and retained authority", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.provenance.mockReturnValue(provenance)
    mocks.scan.mockResolvedValue(stored)
    mocks.current.mockResolvedValue({ status: "QUEUED", deletedAt: null })
    mocks.workspace.mockResolvedValue({ id: "ws-1" })
    mocks.target.mockResolvedValue({ type: "REPO" })
    mocks.operation.mockResolvedValue({
      operationId: "op-1",
      scanId: "scan-1",
      workspaceId: "ws-1",
      requestDigest: "d".repeat(64),
    })
    mocks.member.mockResolvedValue({ role: "OWNER" })
    mocks.entitlement.mockResolvedValue({ allowed: true, accountId: "user-1" })
    mocks.getJob.mockResolvedValue({
      id: data.scanId,
      name: "scan",
      data,
      getState: async () => "waiting",
    })
    mocks.legacy.mockResolvedValue({ status: "completed" })
  })
  it("ingests authenticated receipts before reading state and retains lost or foreign acknowledgements", async () => {
    const f = fixture()
    await f.processor(f.job)
    expect(f.broker.consumeSupervisorReceipts).toHaveBeenCalledWith("op-1")
    expect(f.broker.consumeSupervisorReceipts.mock.invocationCallOrder[0]).toBeLessThan(
      f.broker.status.mock.invocationCallOrder[0]!
    )
    f.broker.consumeSupervisorReceipts.mockRejectedValueOnce(new Error("lost receipt ACK"))
    const statusCalls = f.broker.status.mock.calls.length
    expect((await f.processor(f.job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(f.broker.status).toHaveBeenCalledTimes(statusCalls)
    f.broker.consumeSupervisorReceipts.mockResolvedValueOnce({
      operationId: "foreign-operation",
      confirmedSequence: 0,
      receipts: 0,
      dispositions: [],
    })
    expect((await f.processor(f.job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(f.broker.startPaid).not.toHaveBeenCalled()
    expect(f.broker.startUnmetered).not.toHaveBeenCalled()
  })
  it("defaults closed and has no legacy fallback without installation", async () => {
    const { job } = fixture()
    expect((await createWorkerScanJobProcessor()(job)).errorCategory).toBe(
      "BROKER_AUTHORITY_CLOSED"
    )
    const closed = createWorkerScanJobProcessor({
      kind: "broker",
      adapter: createBrokerWorkerAuthorityAdapter(),
    })
    expect((await closed(job)).errorCategory).toBe("BROKER_AUTHORITY_CLOSED")
    expect(mocks.scan).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("selects legacy only through explicit startup compatibility, never queue fields", async () => {
    const { job } = fixture()
    job.data = Object.assign({}, data, { authorityMode: "broker", payerId: "attacker" })
    await processWorkerScanJob(job)
    expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith(job)
    const invalid = createWorkerScanJobProcessor({
      kind: "legacy",
      compatibility: "unqualified",
    } as never)
    expect((await invalid(job)).errorCategory).toBe("BROKER_AUTHORITY_CLOSED")
    expect(mocks.legacy).toHaveBeenCalledTimes(1)
  })
  it("prepares through the fenced authority and retains the checked intent", async () => {
    const { job, processor, broker, publication } = fixture()
    expect((await processor(job)).errorCategory).toBe("BROKER_DISPATCH_PREPARED")
    expect(publication.verifyDispatch).toHaveBeenCalledWith(
      { operationId: "op-1", workspaceId: "ws-1" },
      expect.objectContaining({ id: "scan-1", data })
    )
    expect(broker.prepare).toHaveBeenCalledWith({
      operationId: "op-1",
      workerInstanceId: "worker-1",
      workerGrantId: "grant-1",
      authorityEpochId: "epoch-1",
      expiresAt: expect.any(Date),
    })
    // Execution is a separate install; a prepared intent never starts paid work.
    expect(broker.startPaid).not.toHaveBeenCalled()
    expect(broker.startUnmetered).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it("retains capacity and unknown preparation outcomes without starting work", async () => {
    const { job, processor, broker } = fixture()
    broker.prepare.mockResolvedValueOnce({
      kind: "waiting",
      operationId: "op-1",
      state: "WAITING_CAPACITY",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_CAPACITY_PENDING")
    broker.prepare.mockResolvedValueOnce({
      kind: "unknown",
      operationId: "op-1",
      reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    broker.prepare.mockRejectedValueOnce(
      Object.assign(new Error("revoked"), { code: "WORKER_GRANT_INVALID" })
    )
    expect((await processor(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(broker.startPaid).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it.each(["id", "workspace", "focus", "grant"])(
    "rejects spoofed %s before broker preparation",
    async (field) => {
      const { job, processor, broker } = fixture()
      if (field === "id") job.id = "foreign"
      if (field === "workspace") job.data = { ...data, workspaceId: "foreign" }
      if (field === "focus") job.data = { ...data, focus: "auth" }
      if (field === "grant") job.data = Object.assign({}, data, { workerGrantId: "attacker" })
      await processor(job)
      expect(broker.prepare).not.toHaveBeenCalled()
      expect(mocks.legacy).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
    }
  )
  it.each(["operation", "publication", "queue"])("retains missing %s authority", async (field) => {
    const { job, processor, broker, publication } = fixture()
    if (field === "operation") mocks.operation.mockResolvedValue(null)
    if (field === "publication") publication.verifyDispatch.mockResolvedValue({ kind: "closed" })
    if (field === "queue") mocks.getJob.mockResolvedValue(null)
    await processor(job)
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it.each(["expired", "tuple", "revoked", "missing"])(
    "closes an %s installation",
    async (field) => {
      const { installation, job, broker } = fixture()
      if (field === "expired") installation.authority.expiresAt = new Date(0)
      if (field === "tuple") installation.authority.productRevision = "f".repeat(40)
      if (field === "revoked") vi.mocked(installation.verifyAuthority).mockResolvedValue(false)
      if (field === "missing") installation.authority.workerGrantId = ""
      await createBrokerWorkerAuthorityAdapter(installation).process(job)
      expect(broker.status).not.toHaveBeenCalled()
      expect(broker.prepare).not.toHaveBeenCalled()
      expect(mocks.legacy).not.toHaveBeenCalled()
    }
  )
  it.each(["member", "target", "delegation"])(
    "rechecks revoked %s without mutating broker state",
    async (field) => {
      const { processor, job, broker } = fixture()
      if (field === "member") mocks.member.mockResolvedValue(null)
      if (field === "target") mocks.target.mockResolvedValue(null)
      if (field === "delegation") {
        mocks.scan.mockResolvedValue({
          ...stored,
          delegatedConnectionId: "connection-1",
          delegatedAuthorizationVersion: 1,
        })
        mocks.connection.mockResolvedValue({ status: "REVOKED" })
      }
      expect((await processor(job)).errorCategory).toBe("SCAN_AUTHORIZATION_REVOKED")
      expect(broker.prepare).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.legacy).not.toHaveBeenCalled()
    }
  )
  it("retains duplicate and lost status acknowledgements under the same operation", async () => {
    const { processor, job, broker } = fixture()
    broker.status.mockRejectedValueOnce(new Error("status acknowledgement lost"))
    expect((await processor(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    broker.status.mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "PREPARING",
      attemptId: "attempt-1",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_DISPATCH_PENDING")
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("rechecks qualification at the final fence and never falls back after revocation", async () => {
    const { processor, job, installation, broker } = fixture()
    vi.mocked(installation.verifyAuthority).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect((await processor(job)).errorCategory).toBe("BROKER_AUTHORITY_UNAVAILABLE")
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(broker.startPaid).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it.each(["member", "permission", "delegation", "sponsor"])(
    "cannot prepare when %s changes concurrently during publication validation",
    async (cause) => {
      const { processor, job, broker, publication } = fixture()
      if (cause === "delegation") {
        mocks.scan.mockResolvedValue({
          ...stored,
          delegatedConnectionId: "connection-1",
          delegatedAuthorizationVersion: 1,
        })
        mocks.connection.mockResolvedValue({
          userId: "user-1",
          status: "ACTIVE",
          authorizationVersion: 1,
          expiresAt: new Date(Date.now() + 60000),
          allowedOperations: ["scan.create"],
          allTargets: true,
        })
      }
      const entered = barrier(),
        released = barrier()
      const positivePublication = publication.verifyDispatch.getMockImplementation()
      if (!positivePublication) throw new Error("publication fixture unavailable")
      publication.verifyDispatch.mockImplementationOnce(async () => {
        entered.release()
        await released.wait
        return positivePublication()
      })
      const delivery = processor(job)
      await entered.wait // The previous admission snapshot allowed this job.
      await Promise.resolve().then(() => {
        if (cause === "member") mocks.member.mockResolvedValue(null)
        if (cause === "permission") mocks.member.mockResolvedValue({ role: "VIEWER" })
        if (cause === "delegation")
          mocks.connection.mockResolvedValue({ status: "REVOKED", authorizationVersion: 2 })
        if (cause === "sponsor")
          mocks.entitlement.mockResolvedValue({ allowed: true, accountId: "changed-sponsor" })
      })
      released.release()
      // The worker's snapshot is now stale on purpose: the fence is the broker's
      // READ COMMITTED transaction, which re-reads the live authority and rejects
      // this exact call. The worker must still call it exactly once and retain.
      broker.prepare.mockImplementationOnce(async () => {
        throw Object.assign(new Error("authority changed"), { code: "WORKER_GRANT_INVALID" })
      })
      expect((await delivery).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
      expect(broker.prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ operationId: "op-1" })
      )
      expect(broker.startPaid).not.toHaveBeenCalled()
      expect(broker.startUnmetered).not.toHaveBeenCalled()
      expect(broker.stop).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.legacy).not.toHaveBeenCalled()
    }
  )
  it("never synthesizes a prepared receipt or starts from PREPARED/UNKNOWN", async () => {
    const { processor, job, broker } = fixture()
    broker.status.mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "PREPARED",
      attemptId: "attempt-1",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_RECEIPT_BRIDGE_UNAVAILABLE")
    broker.status.mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "UNKNOWN",
      attemptId: "attempt-1",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(broker.startPaid).not.toHaveBeenCalled()
    expect(broker.startUnmetered).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("cancels only the persisted attempt and retains a lost stop ACK", async () => {
    const { processor, job, broker } = fixture()
    mocks.current.mockResolvedValue({ status: "CANCELLED", deletedAt: null })
    broker.status.mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "PREPARING",
      attemptId: "attempt-1",
    })
    expect((await processor(job)).errorCategory).toBe("BROKER_STOP_PENDING")
    expect(broker.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        attemptId: "attempt-1",
        reasonCode: "SCAN_CANCELLED",
      })
    )
    broker.stop.mockRejectedValue(new Error("stop ACK unknown"))
    expect((await processor(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it("contains unexpected adapter errors and invalid startup config without legacy fallback", async () => {
    const { job } = fixture()
    const failed = createWorkerScanJobProcessor({
      kind: "broker",
      adapter: {
        process: async () => {
          throw new Error("private client unavailable")
        },
      },
    })
    expect((await failed(job)).errorCategory).toBe("BROKER_OUTCOME_UNKNOWN")
    expect(
      (await createWorkerScanJobProcessor({ kind: "broker", adapter: undefined } as never)(job))
        .errorCategory
    ).toBe("BROKER_AUTHORITY_CLOSED")
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("captures immutable startup mode and keeps restart delivery on the same operation", async () => {
    const { installation, job, broker } = fixture()
    const mode: WorkerAuthorityMode = {
      kind: "broker",
      adapter: createBrokerWorkerAuthorityAdapter(installation),
    }
    const processor = createWorkerScanJobProcessor(mode)
    Object.assign(mode, { kind: "legacy", compatibility: "existing-production-baseline" })
    await processor(job)
    broker.status.mockResolvedValue({
      kind: "available",
      operationId: "op-1",
      state: "PREPARING",
      attemptId: "attempt-1",
    })
    const restarted = createWorkerScanJobProcessor({
      kind: "broker",
      adapter: createBrokerWorkerAuthorityAdapter(installation),
    })
    broker.prepare.mockClear()
    expect((await restarted(job)).errorCategory).toBe("BROKER_DISPATCH_PENDING")
    // A later delivery of a PREPARING operation re-fences through the broker
    // rather than re-preparing or replaying paid work.
    expect(broker.prepare).not.toHaveBeenCalled()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(Object.isFrozen(workerAuthorityStartup)).toBe(true)
    expect(legacyWorkerLifecycleEnabled({ kind: "closed" })).toBe(false)
    expect(
      legacyWorkerLifecycleEnabled({
        kind: "broker",
        adapter: createBrokerWorkerAuthorityAdapter(),
      })
    ).toBe(false)
  })
})
