import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import { createBrokerHandler } from "./http"
import type { BrokerService } from "./service"

const token = "b".repeat(40)
const operationId = "op-1"
const attempt = {
  attemptId: "attempt-1",
  workerInstanceId: "worker-1",
  workerGrantId: "grant-1",
  authorityEpochId: "epoch-1",
}

function service(overrides: Partial<BrokerService> = {}): BrokerService {
  return {
    admission: "closed",
    prepare: async (input) => ({ kind: "waiting", operationId: input.operationId }),
    startPaid: async (input) => ({ kind: "committed", operationId: input.operationId }),
    startUnmetered: async (input) => ({ kind: "committed", operationId: input.operationId }),
    stop: async (input) => ({ kind: "committed", operationId: input.operationId }),
    reconcile: async (input) => ({ kind: "unknown", operationId: input.operationId }),
    consume: async (id) => ({ operationId: id, sequence: 1 }),
    status: async (id) => ({
      kind: "available",
      operationId: id,
      state: "PREPARED",
      attemptId: null,
      preparationEligibility: "CHECKED_INTENT_ONLY",
    }),
    close: async () => undefined,
    ...overrides,
  }
}

async function call(server: Server, path: string, init: RequestInit = {}) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  })
  return { status: response.status, body: await response.json() }
}

async function withServer<T>(target: BrokerService, run: (server: Server) => Promise<T>) {
  const server = createServer(createBrokerHandler(target, token))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    return await run(server)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("broker control surface", () => {
  it("leaves liveness open and refuses every other route without the control token", async () => {
    await withServer(service(), async (server) => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: "ok", admission: "closed" })
      const status = await fetch(`http://127.0.0.1:${address.port}/operations/op-1`)
      expect(status.status).toBe(401)
    })
  })

  it("serves the stored dispatch authority behind the control token", async () => {
    await withServer(service(), async (server) => {
      expect(
        await call(server, "/operations/prepare", {
          method: "POST",
          body: JSON.stringify({
            operationId,
            workerInstanceId: "worker-1",
            workerGrantId: "grant-1",
            authorityEpochId: "epoch-1",
            expiresAt: "2026-11-14T00:00:00.000Z",
          }),
        })
      ).toEqual({ status: 200, body: { kind: "waiting", operationId } })
      expect(
        await call(server, `/operations/${operationId}/start-paid`, {
          method: "POST",
          body: JSON.stringify(attempt),
        })
      ).toEqual({ status: 200, body: { kind: "committed", operationId } })
      expect(await call(server, `/operations/${operationId}`)).toEqual({
        status: 200,
        body: {
          kind: "available",
          operationId,
          state: "PREPARED",
          attemptId: null,
          preparationEligibility: "CHECKED_INTENT_ONLY",
        },
      })
    })
  })

  it("rejects malformed authority input without calling the stored layer", async () => {
    let called = 0
    const counting = service({
      prepare: async () => {
        called += 1
        return {}
      },
    })
    await withServer(counting, async (server) => {
      for (const body of [
        JSON.stringify({ ...attempt, operationId }),
        JSON.stringify({ operationId, ...attempt, expiresAt: "not-a-date" }),
        JSON.stringify({
          operationId,
          ...attempt,
          expiresAt: "2026-11-14T00:00:00.000Z",
          extra: 1,
        }),
        "{}",
      ])
        expect((await call(server, "/operations/prepare", { method: "POST", body })).status).toBe(
          400
        )
      expect(called).toBe(0)
    })
  })

  it("maps stored authority codes instead of echoing internals", async () => {
    const failing = service({
      consume: async () => {
        throw Object.assign(new Error("no consumer"), { code: "SUPERVISOR_CONSUMER_NOT_INSTALLED" })
      },
      status: async () => {
        throw Object.assign(new Error("missing"), { code: "OPERATION_NOT_FOUND" })
      },
    })
    await withServer(failing, async (server) => {
      expect(
        (await call(server, `/operations/${operationId}/consume`, { method: "POST" })).body
      ).toEqual({ error: "SUPERVISOR_CONSUMER_NOT_INSTALLED" })
      expect(
        (await call(server, `/operations/${operationId}/consume`, { method: "POST" })).status
      ).toBe(503)
      expect((await call(server, `/operations/${operationId}`)).status).toBe(409)
      expect(await call(server, "/operations/op-2/unknown")).toEqual({
        status: 404,
        body: { error: "NOT_FOUND" },
      })
    })
  })
})
