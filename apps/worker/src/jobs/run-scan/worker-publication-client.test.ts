import { randomBytes } from "node:crypto"
import { createServer, type RequestOptions, type IncomingMessage } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createBrokerHandler } from "../../../../broker/src/http"
import type { BrokerService } from "../../../../broker/src/service"
import { createWorkerBrokerPublicationVerifier } from "./worker-publication-client"
import { serializeScanQueuePayload } from "@lyrashield/db/src/scan-queue-payload"
import { requireScanDispatchWorkerAssignment } from "@lyrashield/db/src/scan-dispatch-worker-assignment"

const fixture = vi.hoisted(() => ({ socketPath: "" }))
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>()
  return {
    ...actual,
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(options.socketPath).toBe("/run/lyrashield/broker.sock")
      return actual.request({ ...options, socketPath: fixture.socketPath }, callback)
    },
  }
})
const scope = { operationId: "operation-1", workspaceId: "workspace-1" }
const snapshot = {
  id: "scan-1",
  queueName: "scans",
  name: "scan",
  state: "active",
  data: {
    scanId: "scan-1",
    workspaceId: scope.workspaceId,
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "SAFE",
    policyId: "policy-1",
  },
}
const published = {
  kind: "published" as const,
  row: {
    ...scope,
    id: snapshot.id,
    requestDigest: "a".repeat(64),
    executionPlanHash: "b".repeat(64),
    payloadInputJson: serializeScanQueuePayload(snapshot.data),
  },
}
const credential = randomBytes(32).toString("hex")

async function run(body: unknown, work: () => Promise<void>, status = 200) {
  const root = await mkdtemp("/tmp/lyra-publication-")
  fixture.socketPath = join(root, "broker.sock")
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${credential}`)
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(fixture.socketPath, resolve))
  try {
    await work()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}
describe("readonly worker publication client", () => {
  it("accepts only the scoped canonical publication result", async () => {
    await run(published, async () => {
      expect(
        await createWorkerBrokerPublicationVerifier(credential).verifyDispatch(scope, snapshot)
      ).toEqual(published)
    })
  })
  it.each([
    { ...published, row: { ...published.row, operationId: "foreign" } },
    { ...published, row: { ...published.row, workspaceId: "foreign" } },
    { ...published, row: { ...published.row, id: "foreign" } },
    {
      ...published,
      row: { ...published.row, payloadInputJson: published.row.payloadInputJson + " " },
    },
    { ...published, row: { ...published.row, executionPlan: { private: true } } },
    { ...published, row: { ...published.row, payloadInputJson: "x".repeat(9000) } },
  ])("rejects scope drift and extra or unbounded fields", async (body) => {
    await run(body, async () => {
      await expect(
        createWorkerBrokerPublicationVerifier(credential).verifyDispatch(scope, snapshot)
      ).rejects.toThrow()
    })
  })
  it("fails closed on denied transport and malformed request data", async () => {
    await run(
      { error: "UNAUTHORIZED" },
      async () => {
        await expect(
          createWorkerBrokerPublicationVerifier(credential).verifyDispatch(scope, snapshot)
        ).rejects.toThrow("Broker publication is unavailable")
      },
      401
    )
    await expect(
      createWorkerBrokerPublicationVerifier(credential).verifyDispatch(scope, {
        ...snapshot,
        data: { ...snapshot.data, payerId: "foreign" },
      })
    ).rejects.toThrow()
  })
  it("keeps the broker route scoped to persisted worker assignment", async () => {
    const root = await mkdtemp("/tmp/lyra-publication-")
    fixture.socketPath = join(root, "broker.sock")
    const target: Partial<BrokerService> = {
      admission: "open",
      verifyPublication: async (value: unknown) => {
        await requireScanDispatchWorkerAssignment(
          {
            query: async (sql: string) =>
              sql.includes("pg_try")
                ? { rows: [{ held: true }], rowCount: 1 }
                : { rows: [], rowCount: 0 },
          } as never,
          (value as typeof scope).operationId
        )
        return published
      },
    }
    const server = createServer(createBrokerHandler(target as BrokerService, "control".repeat(8)))
    await new Promise<void>((resolve) => server.listen(fixture.socketPath, resolve))
    try {
      await expect(
        createWorkerBrokerPublicationVerifier(credential).verifyDispatch(scope, snapshot)
      ).rejects.toThrow("Broker publication is unavailable")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
