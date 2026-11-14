import { generateKeyPairSync } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  signSupervisorAttemptProof,
  supervisorCommandSchema,
  type SupervisorAttemptProofInput,
} from "@lyrashield/runtime-control"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"
import { createScanDispatchLifecycle } from "./scan-dispatch-lifecycle"

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
})
const input = {
  operationId: "operation-one",
  attemptId: "attempt-one",
  workerGrantId: "grant-one",
  workerInstanceId: "worker-one",
  authorityEpochId: "epoch-one",
}
function fixture(type: "STOP" | "RECONCILE" = "STOP") {
  const scope = {
    workspaceId: "workspace-one",
    scanId: "scan-one",
    workerGrantId: input.workerGrantId,
    workerInstanceId: input.workerInstanceId,
    authorityEpochId: input.authorityEpochId,
    prepareChecksum: "c".repeat(64),
    checked: true,
    grantLive: false,
  }
  let retainedCurrent = true
  let existingCommandId: string | undefined
  let storedStop: { id: string; commandInputJson: string; commandInputChecksum: string } | undefined
  if (type === "RECONCILE") {
    const commandInputJson = canonicalJson({
      type: "STOP",
      commandId: "original-stop-one",
      attemptId: input.attemptId,
      expectedReceiptHash: "b".repeat(64),
    })
    storedStop = {
      id: "original-stop-one",
      commandInputJson,
      commandInputChecksum: sha256Hex(commandInputJson),
    }
  }
  const operation: { state: "ACTIVE" | "UNKNOWN" } = {
    state: type === "STOP" ? "ACTIVE" : "UNKNOWN",
  }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT id,"commandInputJson"'))
      return { rows: storedStop ? [storedStop] : [] }
    if (sql.startsWith("SELECT a.")) return { rows: [scope] }
    if (sql.includes("app.scan_dispatch_lifecycle_proof_current"))
      return { rows: [{ current: retainedCurrent }] }
    if (sql.startsWith('SELECT id FROM "ScanDispatchOutbox"'))
      return { rows: existingCommandId ? [{ id: existingCommandId }] : [] }
    if (sql.startsWith('INSERT INTO "ScanDispatchOutbox"')) existingCommandId = String(values![0])
    return { rows: [] }
  })
  const client = { query } as unknown as pg.PoolClient
  const transaction: DispatchBrokerContext["transaction"] = async (operationId, work) => ({
    kind: "committed",
    operationId,
    value: (await work(client)) as Awaited<ReturnType<typeof work>> & object,
  })
  const lockOperation: DispatchBrokerContext["lockOperation"] = vi.fn(async () => ({
    operationId: input.operationId,
    workspaceId: scope.workspaceId,
    scanId: scope.scanId,
    state: operation.state,
    requestDigest: "request-one",
    userId: "user-one",
    targetId: "target-one",
    sponsorAccountId: "account-one",
  }))
  const readAttemptProof = vi.fn(async (requested: SupervisorAttemptProofInput) => {
    const command = supervisorCommandSchema.parse({
      type: requested.type,
      commandId: requested.commandId,
      attemptId: requested.attemptId,
      expectedReceiptHash: "b".repeat(64),
      ...(requested.executorKey ? { executorKey: requested.executorKey } : {}),
    })
    const now = Date.now()
    return signSupervisorAttemptProof(
      {
        purpose: "lyrashield-supervisor-attempt-proof/2",
        input: requested,
        binding: {
          operationId: requested.operationId,
          attemptId: requested.attemptId,
          workspaceId: requested.workspaceId,
          scanId: requested.scanId,
          authorityEpochId: requested.authorityEpochId,
          authorityRevision: 1,
          workerIdentity: scope.workerInstanceId,
          billingMode: "UNMETERED",
          expiresAt: new Date(now - 60_000).toISOString(),
        },
        supervisorInstanceId: "supervisor-one",
        prepareChecksum: scope.prepareChecksum,
        preparedCompleted: true,
        status: operation.state === "UNKNOWN" ? "UNKNOWN" : "RUNNING",
        command,
        commandChecksum: sha256Hex(canonicalJson(command)),
        headInputChecksum: "d".repeat(64),
        headSequence: 3,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
      },
      { privateKey }
    )
  })
  const nativeTransaction = vi.fn(transaction)
  const cleanupTransaction = vi.fn(transaction)
  const cleanupLockOperation = vi.fn<DispatchBrokerContext["lockOperation"]>((client, binding) =>
    lockOperation(client, binding)
  )
  const lifecycle = createScanDispatchLifecycle({
    context: { transaction, lockOperation },
    nativeTransaction,
    cleanupTransaction,
    cleanupLockOperation,
    stageTransaction: transaction,
    authority: {
      authorityEpochId: input.authorityEpochId,
      supervisorInstanceId: "supervisor-one",
      attemptProofPublicKey: publicKey,
      readAttemptProof,
    },
  })
  return {
    lifecycle,
    query,
    scope,
    operation,
    readAttemptProof,
    nativeTransaction,
    cleanupTransaction,
    cleanupLockOperation,
    denyRetainedProof: () => (retainedCurrent = false),
    retainExistingCommand: (id: string) => (existingCommandId = id),
    setStoredStop: (stop: typeof storedStop) => {
      storedStop = stop
    },
  }
}

describe("retained lifecycle cleanup authority", () => {
  it("selects the first signed STOP for UNKNOWN when reconciliation has no stored STOP", async () => {
    const f = fixture("RECONCILE")
    f.setStoredStop(undefined)
    const result = await f.lifecycle.cleanup(input, "RECONCILE")
    expect(result).toMatchObject({ kind: "committed", state: "STOPPING" })
    expect(f.readAttemptProof).toHaveBeenCalledWith(expect.objectContaining({ type: "STOP" }))
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1)
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })
  it("rejects corrupt stored STOP before minting any reconciliation proof", async () => {
    const f = fixture("RECONCILE")
    f.setStoredStop({
      id: "original-stop-one",
      commandInputJson: "{}",
      commandInputChecksum: "a".repeat(64),
    })
    await expect(f.lifecycle.cleanup(input, "RECONCILE")).rejects.toThrow()
    expect(f.readAttemptProof).not.toHaveBeenCalled()
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false)
  })
  it.each(["STOP", "RECONCILE"] as const)(
    "freezes %s for the original checked identity after its grant is retired",
    async (type) => {
      const f = fixture(type)
      const result = await f.lifecycle.cleanup(input, type)
      expect(result.kind).toBe("committed")
      expect(f.readAttemptProof).toHaveBeenCalledOnce()
      expect(f.nativeTransaction).not.toHaveBeenCalled()
      expect(f.cleanupTransaction).toHaveBeenCalledTimes(3)
      expect(f.cleanupLockOperation).toHaveBeenCalledTimes(2)
      expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1)
      expect(f.query.mock.calls.some(([sql]) => sql.includes('"ScanDispatchStart"'))).toBe(false)
      expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE"))).toHaveLength(
        type === "STOP" ? 1 : 0
      )
    }
  )

  it("freezes one exact STOP from UNKNOWN and reuses it without a new proof or intent", async () => {
    const f = fixture()
    f.operation.state = "UNKNOWN"
    const first = await f.lifecycle.cleanup(input, "STOP")
    const replay = await f.lifecycle.cleanup(input, "STOP")
    expect(first.kind).toBe("committed")
    expect(replay).toEqual(first)
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
    expect(f.readAttemptProof).toHaveBeenCalledOnce()
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('"ScanDispatchStart"'))).toBe(false)
  })

  it("retains an ambiguous existing STOP without minting another command", async () => {
    const f = fixture()
    f.operation.state = "UNKNOWN"
    f.retainExistingCommand("original-stop-one")
    expect(await f.lifecycle.cleanup(input, "STOP")).toMatchObject({
      kind: "committed",
      commandId: "original-stop-one",
    })
    expect(f.readAttemptProof).not.toHaveBeenCalled()
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
  })

  it("denies START from a signed UNKNOWN attempt even if its execution grant is live", async () => {
    const f = fixture()
    f.operation.state = "UNKNOWN"
    f.scope.grantLive = true
    await expect(
      f.lifecycle.start({ ...input, executorKey: "engine" }, "UNMETERED")
    ).rejects.toThrow("Attempt proof authority is unavailable")
    expect(f.cleanupTransaction).not.toHaveBeenCalled()
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
  })

  it.each(["PAID", "UNMETERED"] as const)(
    "denies new %s START after grant retirement",
    async (kind) => {
      const f = fixture()
      await expect(f.lifecycle.start({ ...input, executorKey: "engine" }, kind)).rejects.toThrow(
        "Authenticated lifecycle authority is unavailable"
      )
      expect(f.readAttemptProof).not.toHaveBeenCalled()
      expect(f.nativeTransaction).toHaveBeenCalledOnce()
      expect(f.cleanupTransaction).not.toHaveBeenCalled()
      expect(f.cleanupLockOperation).not.toHaveBeenCalled()
      expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
    }
  )

  it.each(["workerGrantId", "workerInstanceId", "authorityEpochId"] as const)(
    "rejects cleanup with a foreign original %s",
    async (key) => {
      const f = fixture()
      await expect(
        f.lifecycle.cleanup({ ...input, [key]: "foreign-one" }, "STOP")
      ).rejects.toThrow()
      expect(f.readAttemptProof).not.toHaveBeenCalled()
    }
  )

  it("rejects cleanup without an original checked PREPARE", async () => {
    const f = fixture()
    f.scope.checked = false
    await expect(f.lifecycle.cleanup(input, "STOP")).rejects.toThrow()
    expect(f.readAttemptProof).not.toHaveBeenCalled()
  })

  it("still requires the exact retained proof before inserting cleanup", async () => {
    const f = fixture()
    f.denyRetainedProof()
    await expect(f.lifecycle.cleanup(input, "STOP")).rejects.toThrow()
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
  })
})
