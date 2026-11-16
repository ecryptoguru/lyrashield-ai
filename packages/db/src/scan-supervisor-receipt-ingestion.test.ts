import type pg from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { createSupervisorReceiptConsumer } from "./scan-supervisor-receipt-ingestion"
import { withScanDispatchWorkerCredential } from "./scan-dispatch-worker-assignment"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"

const state = vi.hoisted(() => ({ connect: vi.fn(), project: vi.fn() }))
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      connect = state.connect
      async end() {}
    },
  },
}))
vi.mock("./scan-supervisor-receipt-ingestion-projection", () => ({
  projectSupervisorSnapshot: state.project,
}))
const binding = {
  operationId: "operation-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  scanId: "scan-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  workerIdentity: "worker-1",
  billingMode: "UNMETERED",
  expiresAt: "2026-11-14T00:00:00.000Z",
}
const prepare = {
  type: "PREPARE",
  commandId: "prepare-1",
  attempt: binding,
  executors: [
    {
      key: "engine",
      spec: {
        kind: "process",
        command: "/bin/true",
        args: [],
        cwd: "/workspace",
        cgroupPath: "/scan",
        env: {},
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
}
const stop = {
  type: "STOP",
  commandId: "stop-1",
  attemptId: binding.attemptId,
  expectedReceiptHash: "a".repeat(64),
}
const authority: SupervisorReceiptAuthority = {
  connectionString: "postgres://fixture@localhost/fixture",
  streamId: "stream-1",
  authorityEpochId: binding.authorityEpochId,
  supervisorInstanceId: "supervisor-1",
  originalSigningSecret: "a".repeat(48),
  wrapperSigningSecret: "b".repeat(48),
  originalKeyHash: sha256Hex("a".repeat(48)),
  wrapperKeyHash: sha256Hex("b".repeat(48)),
  readJournal: vi.fn(async (cursor) => ({
    records: [],
    snapshotHead: null,
    hasMore: false,
    nextCursor: { ...cursor, snapshotSequence: 0, snapshotHash: "0".repeat(64) },
  })),
}
function fixture(
  options: {
    live?: boolean
    missing?: boolean
    assignedAttempt?: string
    loseBeforeProjection?: boolean
  } = {}
) {
  let retainedChecks = 0
  const row = {
    attemptId: binding.attemptId,
    prepareJson: canonicalJson(prepare),
    prepareChecksum: sha256Hex(canonicalJson(prepare)),
    commandId: stop.commandId,
    commandInputJson: canonicalJson(stop),
    commandInputChecksum: sha256Hex(canonicalJson(stop)),
  }
  const assigned = {
    workerGrantId: "grant-1",
    workerInstanceId: binding.workerIdentity,
    authorityEpochId: binding.authorityEpochId,
    attemptId: options.assignedAttempt ?? binding.attemptId,
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("app.scan_preparation_context"))
      return { rows: [{ workspaceId: binding.workspaceId }], rowCount: 1 }
    if (sql.includes("app.require_scan_dispatch_worker_cleanup")) {
      retainedChecks++
      return {
        rows: options.loseBeforeProjection && retainedChecks === 3 ? [] : [assigned],
        rowCount: options.loseBeforeProjection && retainedChecks === 3 ? 0 : 1,
      }
    }
    if (sql.includes("app.require_scan_dispatch_worker("))
      return { rows: options.live ? [assigned] : [], rowCount: options.live ? 1 : 0 }
    if (sql.includes("pg_try_advisory")) return { rows: [{ held: true }], rowCount: 1 }
    if (sql.includes("FROM pg_roles WHERE rolname=current_user"))
      return { rows: [{ safe: true }], rowCount: 1 }
    if (sql.includes('SELECT a."attemptId",p.'))
      return { rows: options.missing ? [] : [row], rowCount: options.missing ? 0 : 1 }
    if (sql.includes('FROM "ScanSupervisorJournalStream"'))
      return {
        rows: [
          {
            confirmedSequence: "0",
            originalHash: "0".repeat(64),
            wrapperHash: "0".repeat(64),
            headInputJson: null,
          },
        ],
        rowCount: 1,
      }
    return { rows: [], rowCount: 1 }
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  state.connect.mockResolvedValue(client)
  const liveLock = vi.fn(),
    cleanupLock = vi.fn()
  return {
    consumer: createSupervisorReceiptConsumer(authority, liveLock, cleanupLock),
    query,
    liveLock,
    cleanupLock,
  }
}
const scope = {
  operationId: binding.operationId,
  attemptId: binding.attemptId,
  workerGrantId: "grant-1",
  workerInstanceId: binding.workerIdentity,
  authorityEpochId: binding.authorityEpochId,
}
const asWorker = <T>(action: () => Promise<T>) =>
  withScanDispatchWorkerCredential("w".repeat(48), scope, action)
beforeEach(() => {
  vi.clearAllMocks()
  state.project.mockResolvedValue({ operationId: binding.operationId, dispositions: [] })
})
describe("retained receipt consumption", () => {
  it("rechecks original cleanup assignment and immutable STOP at all three receipt boundaries", async () => {
    const f = fixture()
    await asWorker(() => f.consumer.consume(binding.operationId))
    expect(
      f.query.mock.calls.filter(([sql]) => sql.includes("app.require_scan_dispatch_worker_cleanup"))
    ).toHaveLength(3)
    expect(state.project).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      binding.operationId,
      0,
      f.cleanupLock,
      { attemptId: binding.attemptId, commandIds: [stop.commandId] }
    )
  })
  it("keeps current execution on the live verifier and operation lock", async () => {
    const f = fixture({ live: true })
    await asWorker(() => f.consumer.consume(binding.operationId))
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes("app.require_scan_dispatch_worker_cleanup"))
    ).toBe(false)
    expect(state.project.mock.calls[0]?.slice(4)).toEqual([f.liveLock, undefined])
  })
  it.each([
    { missing: true },
    { assignedAttempt: "foreign-attempt" },
    { loseBeforeProjection: true },
  ])("rejects missing, foreign or changed retained authority %j", async (options) => {
    const f = fixture(options)
    await expect(asWorker(() => f.consumer.consume(binding.operationId))).rejects.toMatchObject({
      code: "WORKER_GRANT_INVALID",
    })
    expect(state.project).not.toHaveBeenCalled()
  })
  it("rejects a foreign operation before reading or projecting any journal bytes", async () => {
    const f = fixture()
    await expect(asWorker(() => f.consumer.consume("foreign-operation"))).rejects.toMatchObject({
      code: "WORKER_GRANT_INVALID",
    })
    expect(authority.readJournal).not.toHaveBeenCalled()
    expect(state.project).not.toHaveBeenCalled()
  })
})
