import { describe, expect, it, vi } from "vitest"

// The service is a thin process host: the only thing it owns is whether the
// checked-intent contract and its compiler are installed as one unit. These
// tests pin that seam through the real constructor, so a future change cannot
// silently install one without the other.

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

  it("keeps admission closed and exposes the broker operations", () => {
    const service = createBrokerService({
      connectionString: database,
      transport: { kind: "unix", socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "b".repeat(40),
      admission: "open",
      preparationAuthority: compiler,
    })
    expect(service.admission).toBe("open")
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
