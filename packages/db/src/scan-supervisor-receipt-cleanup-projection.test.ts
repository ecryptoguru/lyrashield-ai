import { createHmac } from "node:crypto"
import type pg from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { projectSupervisorSnapshot } from "./scan-supervisor-receipt-ingestion-projection"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"

const effects = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  cleanup: vi.fn(),
  acknowledge: vi.fn(),
  retire: vi.fn(),
}))
vi.mock("./scan-preparation-authority", () => ({ bindScanPreparationContext: vi.fn() }))
vi.mock("./scan-supervisor-preparation-projection", () => ({
  applyAuthenticatedPreparation: effects.prepare,
}))
vi.mock("./scan-supervisor-start-projection", () => ({ applyAuthenticatedStart: effects.start }))
vi.mock("./scan-supervisor-cleanup-projection", () => ({
  applyAuthenticatedCleanup: effects.cleanup,
}))
vi.mock("./scan-supervisor-native-invocation-resolution", () => ({
  resolveNativeInvocationReceipt: effects.acknowledge,
}))
vi.mock("./scan-native-retirement", () => ({ resolveNativeRetirementReceipt: effects.retire }))

const operation = {
  operationId: "operation-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  scanId: "scan-1",
  authorityEpochId: "epoch-1",
}
const prepare = {
  type: "PREPARE",
  commandId: "prepare-1",
  attempt: {
    ...operation,
    authorityRevision: 1,
    workerIdentity: "worker-1",
    billingMode: "UNMETERED",
    expiresAt: "2026-11-14T00:00:00.000Z",
  },
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
const start = {
  type: "START_UNMETERED",
  commandId: "start-1",
  attemptId: operation.attemptId,
  executorKey: "engine",
  expectedReceiptHash: "a".repeat(64),
}
const stop = {
  type: "STOP",
  commandId: "stop-1",
  attemptId: operation.attemptId,
  expectedReceiptHash: "b".repeat(64),
}
const authority: SupervisorReceiptAuthority = {
  connectionString: "postgres://fixture@localhost/fixture",
  streamId: "stream-1",
  authorityEpochId: operation.authorityEpochId,
  supervisorInstanceId: "supervisor-1",
  originalSigningSecret: "a".repeat(48),
  wrapperSigningSecret: "b".repeat(48),
  originalKeyHash: sha256Hex("a".repeat(48)),
  wrapperKeyHash: sha256Hex("b".repeat(48)),
  readJournal: async () => null,
}
function sign(payload: unknown, sequence: number, secret: string) {
  const body = { version: 1, sequence, previousHash: "0".repeat(64), payload },
    hash = sha256Hex(canonicalJson(body))
  return {
    ...body,
    hash,
    signature: createHmac("sha256", secret)
      .update(canonicalJson({ ...body, hash }))
      .digest("hex"),
  }
}
function fixture(retirementStop = stop.commandId, tamper = false) {
  const events = [
    ...[prepare, start, stop].map((command) => ({ type: "command_intent", command })),
    { type: "attempt_prepared", commandId: prepare.commandId, attemptId: operation.attemptId },
    {
      type: "prepare_invocation_completed",
      commandId: prepare.commandId,
      attemptId: operation.attemptId,
    },
    { type: "native_invocation_ack", commandId: start.commandId, attemptId: operation.attemptId },
    {
      type: "command_terminal",
      commandId: start.commandId,
      attemptId: operation.attemptId,
      status: "STARTED",
    },
    {
      type: "native_invocation_retired",
      commandId: prepare.commandId,
      attemptId: operation.attemptId,
      stopCommandId: retirementStop,
    },
    {
      type: "command_terminal",
      commandId: stop.commandId,
      attemptId: operation.attemptId,
      status: "STOPPED",
    },
  ]
  const sources = events.map((event, index) => {
    const original = sign(
      {
        ...event,
        supervisorInstanceId: authority.supervisorInstanceId,
        observedAt: "2026-11-14T00:00:00.000Z",
      },
      index + 1,
      authority.originalSigningSecret
    )
    const wrapper = sign(
      {
        epochId: operation.authorityEpochId,
        operationId: operation.operationId,
        workspaceId: operation.workspaceId,
        scanId: operation.scanId,
        attemptId: operation.attemptId,
        eventId: `supervisor:${original.hash}`,
        payload: original,
      },
      index + 1,
      authority.wrapperSigningSecret
    )
    return {
      id: `source-${index}`,
      sequence: String(index + 1),
      originalInputJson: canonicalJson(original),
      wrapperInputJson: canonicalJson(wrapper),
    }
  })
  if (tamper)
    sources[0]!.originalInputJson = sources[0]!.originalInputJson.replace(
      "supervisor-1",
      "foreign-owner"
    )
  const commands = [prepare, start, stop].map((command) => {
    const commandInputJson = canonicalJson(command)
    return {
      id: command.commandId,
      attemptId: operation.attemptId,
      commandType: command.type,
      status: "PENDING",
      commandInputJson,
      commandInputChecksum: sha256Hex(commandInputJson),
    }
  })
  const writes: unknown[][] = []
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FROM "ScanSupervisorJournalRecord"')) return { rows: sources }
    if (sql.includes('FROM "ScanDispatchOutbox" c')) return { rows: commands }
    if (sql.includes('SELECT "confirmedSequence"'))
      return { rows: [{ confirmedSequence: String(sources.length) }] }
    if (sql.includes('SELECT "projectionSequence"'))
      return { rows: [{ projectionSequence: 0, projectionHash: null }] }
    if (sql.startsWith('INSERT INTO "ScanSupervisorReceipt"')) writes.push(values)
    return { rows: [] }
  })
  return { client: { query } as unknown as pg.PoolClient, sources, writes }
}
beforeEach(() => {
  vi.clearAllMocks()
  effects.cleanup.mockResolvedValue(true)
})
describe("retained worker cleanup projection", () => {
  it("observes signed acceptance and actual cleanup without acknowledging or finalizing positive work", async () => {
    const f = fixture()
    const result = await projectSupervisorSnapshot(
      f.client,
      authority,
      operation.operationId,
      f.sources.length,
      async () => ({
        ...operation,
        state: "ACTIVE",
        requestDigest: "a",
        userId: "user-1",
        targetId: "target-1",
        sponsorAccountId: "account-1",
      }),
      { attemptId: operation.attemptId, commandIds: [stop.commandId] }
    )
    expect(result.dispositions).toEqual([
      { commandId: stop.commandId, status: "STOPPED", observedStatus: "STOPPED" },
    ])
    expect(effects.prepare).not.toHaveBeenCalled()
    expect(effects.start).not.toHaveBeenCalled()
    expect(effects.acknowledge).not.toHaveBeenCalled()
    expect(effects.retire).toHaveBeenCalledTimes(1)
    expect(f.writes.map((values) => values[16])).toEqual([
      "command_intent",
      "command_intent",
      "command_intent",
      "native_invocation_retired",
      "command_terminal",
    ])
  })
  it("does not resolve retirement through a foreign or positive command", async () => {
    for (const commandId of ["foreign-stop", start.commandId]) {
      const f = fixture(commandId)
      await projectSupervisorSnapshot(
        f.client,
        authority,
        operation.operationId,
        f.sources.length,
        async () => ({
          ...operation,
          state: "ACTIVE",
          requestDigest: "a",
          userId: "user-1",
          targetId: "target-1",
          sponsorAccountId: "account-1",
        }),
        { attemptId: operation.attemptId, commandIds: [stop.commandId] }
      )
    }
    expect(effects.retire).not.toHaveBeenCalled()
  })
  it("still authenticates historical bytes before any retained projection", async () => {
    const f = fixture(stop.commandId, true)
    await expect(
      projectSupervisorSnapshot(
        f.client,
        authority,
        operation.operationId,
        f.sources.length,
        async () => ({
          ...operation,
          state: "ACTIVE",
          requestDigest: "a",
          userId: "user-1",
          targetId: "target-1",
          sponsorAccountId: "account-1",
        }),
        { attemptId: operation.attemptId, commandIds: [stop.commandId] }
      )
    ).rejects.toThrow()
    expect(f.writes).toEqual([])
  })
})
