import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { withScanDispatchWorkerCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"

const state = vi.hoisted(() => ({ outcome: {} as unknown, consumed: vi.fn() }))
vi.mock("@lyrashield/db/src/scan-dispatch-authority-broker", () => ({
  createScanDispatchAuthorityBroker: (options: {
    consumeReceipts(operationId: string): Promise<unknown>
  }) => ({
    prepare: async () => state.outcome,
    dispatchPrepared: async () => state.outcome,
    stop: async () => state.outcome,
    reconcile: async () => state.outcome,
    startPaid: async () => state.outcome,
    startUnmetered: async () => state.outcome,
    consumeSupervisorReceipts: async (id: string) => {
      state.consumed(id)
      return options.consumeReceipts(id)
    },
    close: async () => undefined,
  }),
}))
vi.mock("@lyrashield/db/src/scan-queue-publication-verifier", () => ({
  createScanQueuePublicationVerifier: () => ({ close: async () => undefined }),
}))
import { createBrokerService } from "./service"

describe("broker committed command delivery over protected Unix HTTP", () => {
  it("delivers the server committed selector with original credential before consuming receipts, including closed-admission cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "broker-command-delivery-")),
      socketPath = join(root, "supervisor.sock")
    const token = "s".repeat(48),
      credential = "w".repeat(48),
      events: string[] = [],
      bodies: unknown[] = []
    let status = "STOPPED",
      foreign = false
    const response = () => ({
      commandId: foreign ? "foreign-command" : "command-test",
      attemptId: "attempt-test",
      status,
      receipt: {
        sequence: 1,
        hash: "a".repeat(64),
        signature: "b".repeat(64),
        supervisorInstanceId: "supervisor-test",
        receiptType: "STOPPED",
        evidenceDigest: "c".repeat(64),
        observedAt: new Date().toISOString(),
      },
    })
    const server = createServer(async (request, reply) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      bodies.push(body)
      reply.writeHead(200, { "content-type": "application/json" })
      if (request.url === "/v1/commands") {
        events.push("deliver")
        reply.end(JSON.stringify(response()))
      } else {
        expect(request.url).toBe("/v1/consume-receipts")
        events.push("consume")
        reply.end(
          JSON.stringify({
            operationId: "operation-test",
            confirmedSequence: 1,
            receipts: 1,
            dispositions: [],
          })
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString()
    const service = createBrokerService({
      connectionString: "postgres://broker@localhost/disposable",
      admission: "closed",
      controlToken: "b".repeat(48),
      transport: { kind: "unix", socketPath: join(root, "broker.sock") },
      receiptAuthority: {
        streamId: "stream-test",
        authorityEpochId: "epoch-test",
        supervisorInstanceId: "supervisor-test",
        originalKeyHash: "a".repeat(64),
        wrapperKeyHash: "b".repeat(64),
        socketPath,
        controlToken: token,
        attemptProofPublicKey: publicKey,
      },
    })
    const input = {
      operationId: "operation-test",
      attemptId: "attempt-test",
      workerInstanceId: "worker-test",
      workerGrantId: "grant-test",
      authorityEpochId: "epoch-test",
      reasonCode: "SCAN_CANCELLED",
    }
    state.outcome = {
      kind: "committed",
      operationId: input.operationId,
      attemptId: input.attemptId,
      commandId: "command-test",
      state: "STOPPING",
    }
    try {
      await expect(
        withScanDispatchWorkerCredential(
          credential,
          { operationId: input.operationId, attemptId: input.attemptId },
          () => service.stop(input)
        )
      ).resolves.toEqual(state.outcome)
      expect(events).toEqual(["deliver", "consume"])
      expect(bodies).toEqual([
        { operationId: input.operationId, commandId: "command-test", workerCredential: credential },
        { operationId: input.operationId, workerCredential: credential },
      ])
      await expect(service.startPaid({ ...input, executorKey: "engine" })).rejects.toMatchObject({
        code: "ADMISSION_CLOSED",
      })
      for (const change of ["UNKNOWN", "foreign"]) {
        status = change === "UNKNOWN" ? "UNKNOWN" : "STOPPED"
        foreign = change === "foreign"
        const before = events.length
        await expect(
          withScanDispatchWorkerCredential(
            credential,
            { operationId: input.operationId, attemptId: input.attemptId },
            () => service.stop(input)
          )
        ).resolves.toEqual({
          kind: "unknown",
          operationId: input.operationId,
          reasonCode: "COMMIT_OUTCOME_UNKNOWN",
        })
        expect(events.slice(before)).toEqual(["deliver"])
      }
      state.outcome = { kind: "unknown", operationId: input.operationId }
      const before = events.length
      await expect(service.reconcile(input)).resolves.toEqual(state.outcome)
      expect(events).toHaveLength(before)
    } finally {
      await service.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
