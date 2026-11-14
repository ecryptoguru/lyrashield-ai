import { beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalJson, sha256Hex, supervisorCommandSchema } from "@lyrashield/runtime-control"
import { selectPreparedWorkerStart } from "./scan-dispatch-worker-start"
import { withScanDispatchWorkerCredential } from "./scan-dispatch-worker-assignment"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"

const input = {
  operationId: "operation-one",
  attemptId: "attempt-one",
  authorityEpochId: "epoch-one",
  workerInstanceId: "worker-one",
  workerGrantId: "grant-one",
}
const prepared = supervisorCommandSchema.parse({
  type: "PREPARE",
  commandId: "prepare-one",
  attempt: {
    operationId: input.operationId,
    attemptId: input.attemptId,
    authorityEpochId: input.authorityEpochId,
    workerIdentity: "worker-one",
    workspaceId: "workspace-one",
    scanId: "scan-one",
    authorityRevision: 1,
    billingMode: "UNMETERED",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  executors: ["sandbox", "scanner"].map((key) => ({
    key,
    spec: {
      kind: "process",
      command: "/fixture-tool",
      args: [],
      cwd: "/fixture-work",
      cgroupPath: "/fixture-cgroup",
    },
  })),
})
let row: Record<string, unknown>,
  starts: { executorKey: string; status: string }[],
  revoked: boolean
const query = vi.fn(async (sql: string) => {
  if (sql.includes("pg_try_advisory")) return { rows: [{ held: true }], rowCount: 1 }
  if (sql.includes("require_scan_dispatch_worker("))
    return { rows: revoked ? [] : [{ ...input }], rowCount: revoked ? 0 : 1 }
  if (sql.includes("SELECT p.id")) return { rows: [row], rowCount: 1 }
  if (sql.includes('SELECT "executorKey"')) return { rows: starts, rowCount: starts.length }
  return { rows: [], rowCount: 0 }
})
const context = {
  transaction: async (operationId: string, work: (connection: unknown) => Promise<object>) => ({
    kind: "committed",
    operationId,
    value: await work({ query }),
  }),
  lockOperation: vi.fn(async () => ({
    operationId: input.operationId,
    scanId: "scan-one",
    workspaceId: "workspace-one",
    state: "PREPARED",
    requestDigest: "d".repeat(64),
    userId: "user-one",
    targetId: "target-one",
    sponsorAccountId: "user-one",
  })),
} as unknown as DispatchBrokerContext
const credential = "fixture-worker-credential-with-no-live-authority"
const selected = (value: unknown = input) =>
  withScanDispatchWorkerCredential(credential, input, () =>
    selectPreparedWorkerStart(context, value as typeof input)
  )

// Unit scope/selection fixtures never substitute for native or production ACKs.
describe("server-selected prepared worker START", () => {
  beforeEach(() => {
    query.mockClear()
    starts = []
    revoked = false
    const bytes = canonicalJson(prepared)
    row = {
      id: "prepare-one",
      commandInputJson: bytes,
      commandInputChecksum: sha256Hex(bytes),
      executionPlanHash: "d".repeat(64),
      workerGrantId: input.workerGrantId,
      workerInstanceId: input.workerInstanceId,
      authorityEpochId: input.authorityEpochId,
    }
  })
  it("selects only the first installed executor and exact prepared billing mode", async () => {
    expect(await selected()).toMatchObject({
      kind: "committed",
      value: { input: { ...input, executorKey: "sandbox" }, kind: "UNMETERED" },
    })
    starts = [{ executorKey: "sandbox", status: "COMPLETED" }]
    expect(await selected()).toMatchObject({
      value: { input: { ...input, executorKey: "scanner" } },
    })
    starts.push({ executorKey: "scanner", status: "COMPLETED" })
    expect(await selected()).toMatchObject({ value: { input: null } })
  })
  it.each(["PAID", "UNMETERED"] as const)(
    "takes %s billing kind from immutable PREPARE",
    async (kind) => {
      const command = supervisorCommandSchema.parse({
        ...prepared,
        attempt: { ...prepared.attempt, billingMode: kind },
      })
      const bytes = canonicalJson(command)
      row.commandInputJson = bytes
      row.commandInputChecksum = sha256Hex(bytes)
      expect(await selected()).toMatchObject({ value: { kind } })
    }
  )
  it("requires original worker credential and rejects caller executor or billing selectors", async () => {
    await expect(selectPreparedWorkerStart(context, input)).rejects.toMatchObject({
      code: "WORKER_GRANT_INVALID",
    })
    await expect(selected({ ...input, executorKey: "scanner" })).rejects.toThrow()
    await expect(selected({ ...input, billingMode: "PAID" })).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  })
  it("rejects revoked assignment before selecting a descriptor", async () => {
    revoked = true
    await expect(selected()).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
    expect(query.mock.calls.some(([sql]) => sql.includes("SELECT p.id"))).toBe(false)
  })
  it.each(["PENDING", "ACCEPTED", "UNKNOWN", "REJECTED"])(
    "retains prior %s START without selecting or retrying another executor",
    async (status) => {
      starts = [{ executorKey: "sandbox", status }]
      await expect(selected()).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_BUSY" })
    }
  )
  it("rejects descriptor corruption, scope substitution and foreign START history", async () => {
    row.commandInputChecksum = "0".repeat(64)
    await expect(selected()).rejects.toMatchObject({ code: "DISPATCH_REPLAY_CONFLICT" })
    row.commandInputChecksum = sha256Hex(row.commandInputJson as string)
    row.workerGrantId = "other-grant"
    await expect(selected()).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_UNAVAILABLE" })
    row.workerGrantId = input.workerGrantId
    starts = [{ executorKey: "unknown-executor", status: "COMPLETED" }]
    await expect(selected()).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_UNAVAILABLE" })
  })
})
