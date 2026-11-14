import { describe, expect, it, vi } from "vitest"

// Pin admission and compiler installation through the real service constructor.

const brokerOptions: unknown[] = []

vi.mock("@lyrashield/db/src/scan-dispatch-authority-broker", () => ({
  createScanDispatchAuthorityBroker: (options: unknown) => {
    brokerOptions.push(options)
    return {
      prepare: async () => ({ kind: "committed" }),
      startPaid: async () => ({ kind: "committed" }),
      startUnmetered: async () => ({ kind: "committed" }),
      stop: async () => ({ kind: "committed" }),
      reconcile: async () => ({ kind: "unknown" }),
      consumeSupervisorReceipts: async () => ({}),
      status: async () => ({ kind: "unknown" }),
      close: async () => undefined,
    }
  },
}))

vi.mock("@lyrashield/db/src/scan-supervisor-receipt-source", () => ({
  createProtectedSupervisorReceiptAuthority: () => ({ kind: "receipt" }),
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
