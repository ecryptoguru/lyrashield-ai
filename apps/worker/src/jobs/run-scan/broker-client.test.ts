import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createBrokerHandler } from "../../../../broker/src/http"
import type { BrokerService } from "../../../../broker/src/service"
import { createWorkerBrokerClient } from "./broker-client"

const fixture = vi.hoisted(() => ({ socketPath: "" }))
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>()
  return {
    ...actual,
    request: (
      options: import("node:http").RequestOptions,
      callback: (response: import("node:http").IncomingMessage) => void
    ) => {
      if (options.socketPath !== "/run/lyrashield/broker.sock") throw new Error("unexpected socket")
      return actual.request({ ...options, socketPath: fixture.socketPath }, callback)
    },
  }
})

const token = "fixture-broker-control-token-at-least-32-characters"
const attempt = {
  operationId: "operation-1",
  attemptId: "attempt-1",
  workerInstanceId: "worker-1",
  workerGrantId: "grant-1",
  authorityEpochId: "epoch-1",
}
const acceptedAt = new Date("2026-11-14T10:00:00.000Z")
const deadlineAt = new Date("2026-11-14T10:00:10.000Z")
const preparation = {
  operationId: attempt.operationId,
  workerInstanceId: attempt.workerInstanceId,
  workerGrantId: attempt.workerGrantId,
  authorityEpochId: attempt.authorityEpochId,
  expiresAt: deadlineAt,
}

function service(overrides: Partial<BrokerService> = {}): BrokerService {
  return {
    admission: "closed",
    prepare: async (input) => ({
      kind: "committed",
      operationId: input.operationId,
      state: "PREPARING",
      attemptId: "attempt-1",
      commandId: "command-1",
      authorityAcceptedAt: acceptedAt,
      authorityDeadlineAt: deadlineAt,
      eligibility: "CHECKED_INTENT_ONLY",
    }),
    status: async (operationId) => ({
      kind: "available",
      operationId,
      state: "PREPARED",
      attemptId: "attempt-1",
      preparationEligibility: "CHECKED_INTENT_ONLY",
    }),
    stop: async (input) => ({
      kind: "committed",
      operationId: input.operationId,
      attemptId: input.attemptId,
      state: "STOPPING",
      commandId: "stop-1",
    }),
    reconcile: async (input) => ({
      kind: "committed",
      operationId: input.operationId,
      attemptId: input.attemptId,
      state: "UNKNOWN",
      commandId: "reconcile-1",
    }),
    consume: async (operationId) => ({
      operationId,
      confirmedSequence: 1,
      receipts: 1,
      dispositions: [{ commandId: "command-1", status: "PREPARED", observedStatus: "PREPARED" }],
    }),
    startPaid: async () => ({}),
    startUnmetered: async () => ({}),
    close: async () => undefined,
    ...overrides,
  }
}

async function withServer<T>(server: Server, run: () => Promise<T>) {
  const directory = await mkdtemp("/tmp/lyra-broker-")
  fixture.socketPath = join(directory, "broker.sock")
  await new Promise<void>((resolve) => server.listen(fixture.socketPath, resolve))
  try {
    return await run()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(directory, { recursive: true, force: true })
  }
}

describe("worker broker client", () => {
  it("uses the actual authenticated broker routes and preserves authority identity", async () => {
    let prepared = 0
    const target = service({
      prepare: async (input) => {
        prepared++
        expect(input.expiresAt).toEqual(deadlineAt)
        return {
          kind: "committed",
          operationId: input.operationId,
          state: "PREPARING",
          attemptId: "attempt-1",
          commandId: "command-1",
          authorityAcceptedAt: acceptedAt,
          authorityDeadlineAt: deadlineAt,
          eligibility: "CHECKED_INTENT_ONLY",
        }
      },
    })
    await withServer(createServer(createBrokerHandler(target, token)), async () => {
      const client = createWorkerBrokerClient(token)
      expect(await client.prepare(preparation)).toMatchObject({
        operationId: attempt.operationId,
        kind: "committed",
        authorityAcceptedAt: acceptedAt,
      })
      expect(await client.status(attempt.operationId)).toMatchObject({
        kind: "available",
        state: "PREPARED",
      })
      expect(await client.consumeSupervisorReceipts(attempt.operationId)).toMatchObject({
        confirmedSequence: 1,
      })
      expect(await client.stop({ ...attempt, reasonCode: "SCAN_CANCELLED" })).toMatchObject({
        state: "STOPPING",
      })
      expect(await client.reconcile(attempt)).toMatchObject({ state: "UNKNOWN" })
      expect(prepared).toBe(1)
    })
  })

  it("rejects mismatched operation and malformed responses", async () => {
    await withServer(
      createServer(
        createBrokerHandler(
          service({
            status: async () => ({
              kind: "unknown",
              operationId: "other-operation",
              reasonCode: "STATUS_UNAVAILABLE",
            }),
            consume: async () => ({ operationId: "operation-1", dispositions: "invalid" }),
          }),
          token
        )
      ),
      async () => {
        const client = createWorkerBrokerClient(token)
        await expect(client.status(attempt.operationId)).rejects.toThrow()
        await expect(client.consumeSupervisorReceipts(attempt.operationId)).rejects.toThrow()
      }
    )
  })

  it("does not retry an unacknowledged mutation or expose the token", async () => {
    let calls = 0
    const server = createServer((request) => {
      calls++
      expect(request.headers.authorization).toBe(`Bearer ${token}`)
      request.socket.destroy()
    })
    await withServer(server, async () => {
      const client = createWorkerBrokerClient(token)
      const error = await client.prepare(preparation).catch((reason: Error) => reason)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).not.toContain(token)
      expect(calls).toBe(1)
    })
  })

  it("refuses an invalid control token and operation identity before transport", async () => {
    expect(() => createWorkerBrokerClient("short")).toThrow()
    let calls = 0
    await withServer(
      createServer(() => {
        calls++
      }),
      async () => {
        const client = createWorkerBrokerClient(token)
        await expect(client.status("../other")).rejects.toThrow()
        expect(calls).toBe(0)
      }
    )
  })

  it("rejects an oversized response even when its receipt shape is valid", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          operationId: attempt.operationId,
          confirmedSequence: 1,
          receipts: 1,
          dispositions: Array(5000).fill({
            commandId: "command-1",
            status: "HELD",
            observedStatus: "PREPARED",
          }),
        })
      )
    })
    await withServer(server, async () => {
      await expect(
        createWorkerBrokerClient(token).consumeSupervisorReceipts(attempt.operationId)
      ).rejects.toThrow()
    })
  })

  it("times out an unresponsive broker without retrying", async () => {
    let calls = 0
    await withServer(
      createServer(() => {
        calls++
      }),
      async () => {
        await expect(createWorkerBrokerClient(token).status(attempt.operationId)).rejects.toThrow()
        expect(calls).toBe(1)
      }
    )
  }, 10000)
})
