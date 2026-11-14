import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { buildScanQueuePayload, scanQueueDigest } from "./scan-queue-payload"
import { computeScanExecutionPlanHash } from "./scan-execution-plan"
import { createScanQueuePublicationProof } from "./scan-queue-publication-proof"
import { withScanDispatchWorkerCredential } from "./scan-dispatch-worker-assignment"
import type { QueueOutboxRow } from "./scan-queue-outbox-store"

const database = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), end: vi.fn() }))
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      connect() {
        return Promise.resolve({ query: database.query, release: database.release })
      }
      end() {
        return database.end()
      }
    },
  },
}))
import { createScanQueuePublicationVerifier } from "./scan-queue-publication-verifier"

const scope = { operationId: "operation-1", workspaceId: "workspace-1" }
const scan = {
  id: "scan-1",
  workspaceId: scope.workspaceId,
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "SAFE",
  policyId: null,
} as const
const payload = buildScanQueuePayload(scan)
const snapshot = {
  id: scan.id,
  queueName: "scans",
  name: "scan",
  data: JSON.parse(payload),
  state: "active",
}
const plan = buildScanExecutionPlan({
  targetType: "REPO",
  mode: "SAFE",
  source: { revision: "a".repeat(40) },
})
const identity = {
  outboxId: "outbox-1",
  operationId: scope.operationId,
  jobId: scan.id,
  payloadDigest: scanQueueDigest(payload),
}
const receipt = createScanQueuePublicationProof(identity, payload, snapshot)
const credential = "c".repeat(64)
const credentialHash = createHash("sha256").update(credential).digest("hex")
let row: QueueOutboxRow
beforeEach(() => {
  vi.clearAllMocks()
  row = {
    ...scan,
    ...identity,
    state: "PUBLISHED",
    operationState: "QUEUED",
    payloadInputJson: payload,
    publicationReceiptInputJson: receipt.input,
    publicationReceiptChecksum: receipt.checksum,
    requestDigest: "b".repeat(64),
    currentScopeDigest: "b".repeat(64),
    executionPlan: plan,
    executionPlanHash: computeScanExecutionPlanHash(plan),
    live: true,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseLive: false,
  }
  database.query.mockImplementation(async (sql: string, values?: string[]) => {
    if (/\b(?:INSERT|UPDATE|DELETE)\b|FOR UPDATE/.test(sql))
      throw new Error("readonly reader attempted a mutation")
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ held: true }], rowCount: 1 }
    if (sql.includes("require_scan_dispatch_worker("))
      return values?.[0] === scope.operationId && values?.[1] === credentialHash
        ? {
            rows: [
              {
                workerGrantId: "grant-1",
                workerInstanceId: "worker-1",
                authorityEpochId: "epoch-1",
                attemptId: null,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    if (sql.includes('SELECT o."scanId"'))
      return {
        rows: [{ scanId: scan.id, userId: "user-1", sponsorId: "user-1", targetId: scan.targetId }],
        rowCount: 1,
      }
    if (sql.includes('q.id AS "outboxId"')) return { rows: [row], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
})
const verify = (input = { ...scope, snapshot }, token = credential) =>
  withScanDispatchWorkerCredential(token, { operationId: scope.operationId }, async () => {
    const reader = createScanQueuePublicationVerifier(
      "postgres://broker@127.0.0.1:5432/lyrashield_test"
    )
    try {
      return await reader.verifyDispatch(input)
    } finally {
      await reader.close()
    }
  })
describe("readonly scoped publication verification", () => {
  it("passes only strict scope to the persisted reader and returns bounded published facts", async () => {
    expect(await verify()).toEqual({
      kind: "published",
      row: {
        ...scope,
        id: scan.id,
        executionPlanHash: row.executionPlanHash,
        requestDigest: row.requestDigest,
        payloadInputJson: payload,
      },
    })
    expect(database.query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
    expect(
      database.query.mock.calls.some(([sql]) => sql.includes("require_scan_preparation_role"))
    ).toBe(true)
  })
  it("reads retained PREPARED publication but keeps ACTIVE closed", async () => {
    row.operationState = "PREPARED"
    expect((await verify()).kind).toBe("published")
    row.operationState = "ACTIVE"
    expect(await verify()).toEqual({ kind: "closed" })
  })
  it("rejects wrong worker credentials before reading publication bytes", async () => {
    await expect(verify(undefined, "d".repeat(64))).rejects.toMatchObject({
      code: "WORKER_GRANT_INVALID",
    })
    expect(database.query.mock.calls.some(([sql]) => sql.includes('q.id AS "outboxId"'))).toBe(
      false
    )
  })
  it("rejects current plan or immutable payload drift", async () => {
    row.executionPlanHash = "f".repeat(64)
    expect(await verify()).toEqual({ kind: "closed" })
    row.executionPlanHash = computeScanExecutionPlanHash(plan)
    row.payloadInputJson = payload + " "
    expect(await verify()).toEqual({ kind: "closed" })
  })
  it("rejects a changed queue snapshot without publishing or quarantining", async () => {
    expect(await verify({ ...scope, snapshot: { ...snapshot, id: "foreign" } })).toEqual({
      kind: "closed",
    })
    expect(row.state).toBe("PUBLISHED")
  })
})
