import { generateKeyPairSync } from "node:crypto"
import { withScanDispatchWorkerCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import { describe, expect, it, vi } from "vitest"

// Pin admission and compiler installation through the real service constructor.

const brokerOptions: unknown[] = []
const sourceOptions: unknown[] = []
const consumed: unknown[] = []
const results: unknown[] = []
const preparationEvents: string[] = []

vi.mock("@lyrashield/db/src/scan-dispatch-authority-broker", () => ({
  createScanDispatchAuthorityBroker: (options: unknown) => {
    brokerOptions.push(options)
    return {
      prepare: async () => {
        preparationEvents.push("prepare")
        return { kind: "committed" }
      },
      startPaid: async () => ({ kind: "committed" }),
      startUnmetered: async () => ({ kind: "committed" }),
      dispatchPrepared: async () => ({ kind: "committed" }),
      stop: async () => ({ kind: "committed" }),
      reconcile: async () => ({ kind: "unknown" }),
      consumeSupervisorReceipts: async () => ({}),
      status: async () => ({ kind: "unknown" }),
      close: async () => undefined,
    }
  },
}))

vi.mock("@lyrashield/db/src/scan-supervisor-receipt-source", () => ({
  createProtectedSupervisorAttemptProofAuthority: (options: unknown) => {
    sourceOptions.push(options)
    return {
      ...(options as object),
      readAttemptProof: async () => undefined,
      readResult: async (input: { operationId: string; attemptId: string }, credential: string) => {
        results.push({ input, credential })
        return { kind: "pending", operationId: input.operationId, attemptId: input.attemptId }
      },
      consume: async (operationId: string, credential?: string) => {
        consumed.push({ operationId, credential })
        return { operationId, receipts: 0, dispositions: [] }
      },
    }
  },
}))

const { createBrokerService } = await import("./service")

const database = "postgres://broker@127.0.0.1:5432/lyrashield_test"
const compiler = Object.assign(async () => ({ executors: [], provider: undefined }), {
  marker: "installed",
})
const attempt = {
  operationId: "op-1",
  attemptId: "attempt-1",
  workerInstanceId: "worker-1",
  workerGrantId: "grant-1",
  authorityEpochId: "epoch-1",
}
const preparation = {
  operationId: attempt.operationId,
  workerInstanceId: attempt.workerInstanceId,
  workerGrantId: attempt.workerGrantId,
  authorityEpochId: attempt.authorityEpochId,
  expiresAt: new Date("2026-11-14T00:00:00.000Z"),
}

function lastOptions() {
  return brokerOptions.at(-1) as {
    preparationAuthority?: string
    compilePreparation?: unknown
  }
}

describe("broker service preparation installation", () => {
  it("finishes authorized source staging before the preparation gate and aborts on staging failure", async () => {
    const make = (stageOperation: (operationId: string) => Promise<void>) =>
      createBrokerService({
        connectionString: database,
        transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
        controlToken: "b".repeat(40),
        admission: "open",
        preparationAuthority: compiler,
        stageOperation,
      })
    const beginning = preparationEvents.length
    const stage = vi.fn(async () => {
      preparationEvents.push("stage")
    })
    await expect(make(stage).prepare(preparation)).resolves.toEqual({ kind: "committed" })
    expect(stage).toHaveBeenCalledWith(preparation.operationId)
    expect(preparationEvents.slice(beginning)).toEqual(["stage", "prepare"])
    const beforeFailure = preparationEvents.length
    await expect(
      make(async () => {
        throw new Error("source revoked")
      }).prepare(preparation)
    ).rejects.toThrow("source revoked")
    expect(preparationEvents).toHaveLength(beforeFailure)
  })
  it("installs public-only proof transport and forwards only the current worker receipt credential", async () => {
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const service = createBrokerService({
      connectionString: database,
      lifecycleConnectionString: "postgres://ledger@127.0.0.1:5432/lyrashield_test",
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "closed",
      receiptAuthority: {
        streamId: "stream-test",
        authorityEpochId: "epoch-test",
        supervisorInstanceId: "supervisor-test",
        originalKeyHash: "a".repeat(64),
        wrapperKeyHash: "b".repeat(64),
        socketPath: "/run/lyrashield/supervisor.sock",
        attemptProofPublicKey: publicKey,
        controlToken: "s".repeat(40),
      },
    })
    const source = sourceOptions.at(-1)
    expect(source).toMatchObject({ attemptProofPublicKey: publicKey })
    for (const field of [
      "connectionString",
      "originalSigningSecret",
      "wrapperSigningSecret",
      "privateKey",
    ])
      expect(source).not.toHaveProperty(field)
    const options = brokerOptions.at(-1) as {
      consumeReceipts(operationId: string): Promise<unknown>
    }
    expect(options).not.toHaveProperty("receiptAuthority")
    expect(options).toHaveProperty("attemptProofAuthority")
    expect(options).toHaveProperty("lifecycleConnectionString")
    const credential = "w".repeat(40)
    const resultInput = { operationId: "operation-test", attemptId: "attempt-test", offset: 0 }
    await expect(service.readResult!(resultInput)).rejects.toMatchObject({
      code: "WORKER_GRANT_INVALID",
    })
    await withScanDispatchWorkerCredential(
      credential,
      { operationId: resultInput.operationId, attemptId: resultInput.attemptId },
      () => service.readResult!(resultInput)
    )
    expect(results.at(-1)).toEqual({ input: resultInput, credential })
    const resultCount = results.length
    await expect(
      withScanDispatchWorkerCredential(credential, { operationId: "foreign-operation" }, async () =>
        service.readResult!(resultInput)
      )
    ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
    expect(results).toHaveLength(resultCount)
    await withScanDispatchWorkerCredential(credential, { operationId: "operation-test" }, () =>
      options.consumeReceipts("operation-test")
    )
    expect(consumed.at(-1)).toEqual({ operationId: "operation-test", credential })
    const count = consumed.length
    await expect(
      withScanDispatchWorkerCredential(credential, { operationId: "operation-test" }, async () =>
        options.consumeReceipts("foreign-operation")
      )
    ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
    expect(consumed).toHaveLength(count)
    await options.consumeReceipts("operation-test")
    expect(consumed.at(-1)).toEqual({ operationId: "operation-test", credential: undefined })
    await service.close()
  })

  it("refuses preparation when no compiler is installed", () => {
    createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "closed",
    })
    expect(lastOptions().preparationAuthority).toBeUndefined()
    expect(lastOptions().compilePreparation).toBeUndefined()
  })

  it("installs the checked-intent contract and its compiler as one unit", () => {
    createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "closed",
      preparationAuthority: compiler,
    })
    expect(lastOptions()).toMatchObject({
      preparationAuthority: "checked-intent-v1",
      compilePreparation: compiler,
    })
  })

  it("refuses new work when admission is closed, while preserving recovery", async () => {
    const service = createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "closed",
      preparationAuthority: compiler,
    })
    for (const result of [
      service.prepare(preparation),
      service.startPaid(attempt),
      service.startUnmetered(attempt),
    ]) {
      await expect(result).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
    }
    await expect(service.stop({ ...attempt, reasonCode: "SCAN_CANCELLED" })).resolves.toEqual({
      kind: "committed",
    })
    await expect(service.reconcile(attempt)).resolves.toEqual({ kind: "unknown" })
    await expect(service.consume("op-1")).resolves.toEqual({})
    await expect(service.status("op-1")).resolves.toEqual({ kind: "unknown" })
  })

  it("does not open admission without an installed compiler", async () => {
    const service = createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "open",
    })
    expect(service.admission).toBe("closed")
    await expect(service.startPaid(attempt)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" })
  })

  it("exposes broker operations when admission and preparation are installed", async () => {
    const service = createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "open",
      preparationAuthority: compiler,
    })
    expect(service.admission).toBe("open")
    await expect(service.prepare(preparation)).resolves.toEqual({ kind: "committed" })
    await expect(service.startPaid(attempt)).resolves.toEqual({ kind: "committed" })
    await expect(service.dispatchPrepared!(attempt)).resolves.toEqual({ kind: "committed" })
    await expect(service.startUnmetered(attempt)).resolves.toEqual({ kind: "committed" })
    for (const operation of [
      "prepare",
      "startPaid",
      "startUnmetered",
      "stop",
      "reconcile",
      "consume",
      "status",
      "close",
    ] as const) {
      expect(typeof service[operation]).toBe("function")
    }
  })
})
