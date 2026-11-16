import { createServer, type Server } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  requireScanDispatchWorkerAssignment,
  scanDispatchWorkerReceiptCredential,
} from "@lyrashield/db/src/scan-dispatch-worker-assignment"
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
  it("proxies result chunks only under the original scoped worker credential", async () => {
    const credential = randomBytes(32).toString("hex")
    let calls = 0
    await withServer(
      service({
        readResult: async (value) => {
          expect(value).toEqual({ operationId, attemptId: attempt.attemptId, offset: 0 })
          expect(scanDispatchWorkerReceiptCredential(operationId)).toBe(credential)
          calls++
          return { kind: "pending", operationId, attemptId: attempt.attemptId }
        },
      }),
      async (server) => {
        const send = (body: unknown, tokenValue = credential) =>
          call(server, `/operations/${operationId}/result`, {
            method: "POST",
            headers: { authorization: `Bearer ${tokenValue}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((await send({ attemptId: attempt.attemptId, offset: 0 })).status).toBe(200)
        expect((await send({ attemptId: attempt.attemptId, offset: 0 }, token)).status).toBe(403)
        for (const body of [
          { attemptId: attempt.attemptId, offset: -1 },
          { attemptId: attempt.attemptId, offset: 0, path: "/tmp/output" },
        ])
          expect((await send(body)).status).toBe(400)
        expect(calls).toBe(1)
        expect(scanDispatchWorkerReceiptCredential(operationId)).toBeUndefined()
      }
    )
  })

  it("accepts only worker-bound dispatch without caller executor or billing choices", async () => {
    const workerCredential = randomBytes(32).toString("hex")
    const digest = createHash("sha256").update(workerCredential).digest("hex")
    const client = {
      query: async (sql: string, values?: string[]) =>
        sql.includes("pg_try")
          ? { rows: [{ held: true }], rowCount: 1 }
          : values?.[1] === digest
            ? { rows: [{ ...attempt, workerGrantId: attempt.workerGrantId }], rowCount: 1 }
            : { rows: [], rowCount: 0 },
    } as unknown as Parameters<typeof requireScanDispatchWorkerAssignment>[0]
    let calls = 0
    await withServer(
      service({
        dispatchPrepared: async (input) => {
          await requireScanDispatchWorkerAssignment(client, input.operationId)
          calls++
          expect(input).toEqual({ ...attempt, operationId })
          return { kind: "idle", operationId, attemptId: input.attemptId }
        },
      }),
      async (server) => {
        const path = `/operations/${operationId}/dispatch`
        const send = (body: unknown, credential = workerCredential) =>
          call(server, path, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((await send(attempt)).status).toBe(200)
        expect((await send({ ...attempt, executorKey: "sandbox" })).status).toBe(400)
        expect((await send({ ...attempt, billingMode: "paid" })).status).toBe(400)
        expect((await send(attempt, token)).status).toBe(403)
        expect((await send(attempt, randomBytes(32).toString("hex"))).status).toBe(401)
        expect(calls).toBe(1)
      }
    )
  })

  it("uses assigned worker credentials for scoped routes and rejects worker START authority", async () => {
    const workerCredential = randomBytes(32).toString("hex")
    const digest = createHash("sha256").update(workerCredential).digest("hex")
    const client = {
      query: async (sql: string, values?: string[]) =>
        sql.includes("pg_try_advisory_xact_lock")
          ? { rowCount: 1, rows: [{ held: true }] }
          : values?.[0] === operationId && values?.[1] === digest
            ? { rowCount: 1, rows: [{ ...attempt, workerGrantId: "grant-1" }] }
            : { rowCount: 0, rows: [] },
    } as unknown as Parameters<typeof requireScanDispatchWorkerAssignment>[0]
    let starts = 0
    let stopped = 0
    const target = service({
      status: async (id) => {
        await requireScanDispatchWorkerAssignment(client, id)
        return {
          kind: "available",
          operationId: id,
          state: "PREPARED",
          attemptId: "attempt-1",
          preparationEligibility: "CHECKED_INTENT_ONLY",
        }
      },
      stop: async (input) => {
        await requireScanDispatchWorkerAssignment(client, input.operationId)
        stopped++
        return { kind: "committed", operationId: input.operationId }
      },
      startPaid: async () => {
        starts++
        return {}
      },
    })
    await withServer(target, async (server) => {
      const headers = { authorization: `Bearer ${workerCredential}` }
      expect(await call(server, `/operations/${operationId}`, { headers })).toEqual({
        status: 200,
        body: {
          kind: "available",
          operationId,
          state: "PREPARED",
          attemptId: "attempt-1",
          preparationEligibility: "CHECKED_INTENT_ONLY",
        },
      })
      expect(await call(server, "/operations/op-other", { headers })).toEqual({
        status: 401,
        body: { error: "UNAUTHORIZED" },
      })
      expect(
        await call(server, `/operations/${operationId}`, {
          headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` },
        })
      ).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } })
      expect(
        await call(server, `/operations/${operationId}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...attempt,
            workerInstanceId: "another-worker",
            reasonCode: "SCAN_CANCELLED",
          }),
        })
      ).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } })
      expect(
        await call(server, `/operations/${operationId}/start-paid`, {
          method: "POST",
          headers,
          body: JSON.stringify(attempt),
        })
      ).toEqual({ status: 403, body: { error: "CONTROL_AUTHORITY_REQUIRED" } })
      expect(starts).toBe(0)
      expect(stopped).toBe(0)
    })
  })
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

  it("maps closed and unavailable preparation authority to bounded 503 responses", async () => {
    const failing = service({
      prepare: async () => {
        throw Object.assign(new Error("closed"), { code: "PREPARATION_AUTHORITY_CLOSED" })
      },
      startPaid: async () => {
        throw Object.assign(new Error("closed"), { code: "ADMISSION_CLOSED" })
      },
      startUnmetered: async () => {
        throw Object.assign(new Error("policy mismatch"), {
          code: "PREPARATION_AUTHORITY_UNAVAILABLE",
        })
      },
      stop: async () => {
        throw Object.assign(new Error("busy"), { code: "PREPARATION_AUTHORITY_BUSY" })
      },
    })
    await withServer(failing, async (server) => {
      expect(
        (
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
        ).status
      ).toBe(503)
      expect(
        await call(server, `/operations/${operationId}/start-paid`, {
          method: "POST",
          body: JSON.stringify(attempt),
        })
      ).toEqual({ status: 503, body: { error: "ADMISSION_CLOSED" } })
      expect(
        (
          await call(server, `/operations/${operationId}/start-unmetered`, {
            method: "POST",
            body: JSON.stringify(attempt),
          })
        ).status
      ).toBe(503)
      expect(
        (
          await call(server, `/operations/${operationId}/stop`, {
            method: "POST",
            body: JSON.stringify({ ...attempt, reasonCode: "SCAN_CANCELLED" }),
          })
        ).status
      ).toBe(503)
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
