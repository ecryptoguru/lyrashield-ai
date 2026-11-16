import { scanDispatchWorkerReceiptCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import { fixtureAuthorityFence } from "./test-fixtures"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
  type ResourceInspection,
  type ResourceOwnership,
  type SupervisorPort,
} from "@lyrashield/runtime-control"
import type { RuntimeExecutor } from "./executor"
import { createSupervisorHandler } from "./http"
import { SupervisorService, supervisorJournalEventSchema } from "./service"

const roots: string[] = []
const secret = "h".repeat(48)
const control = "c".repeat(48)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class NoopExecutor implements RuntimeExecutor {
  async create(): Promise<ResourceOwnership> {
    throw new Error("closed admission must not create")
  }
  async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
    return ownership
  }
  async inspect(): Promise<ResourceInspection> {
    return { state: "ABSENT" }
  }
  async stop(): Promise<ResourceInspection> {
    return { state: "ABSENT" }
  }
}

class NoopGateway implements SupervisorPort {
  async issueGrant(): Promise<never> {
    throw new Error("closed admission must not issue")
  }
  async findGrantByRequest(): Promise<never> {
    throw new Error("closed admission must not inspect")
  }
  async revokeGrant(_request: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    throw new Error("closed admission must not revoke")
  }
  async inspectGrant(): Promise<null> {
    return null
  }
}

describe("supervisor HTTP boundary", () => {
  it("accepts only persisted selectors from the scoped broker and carries original worker scope to execution", async () => {
    const credential = "w".repeat(48),
      scoped = "s".repeat(48)
    const command = {
      type: "STOP",
      commandId: "command-http",
      attemptId: "attempt-http",
      expectedReceiptHash: "a".repeat(64),
    }
    const read = vi.fn(async (input: unknown) => {
      expect(input).toEqual({ operationId: "operation-http", commandId: "command-http" })
      expect(scanDispatchWorkerReceiptCredential("operation-http")).toBe(credential)
      return command
    })
    const execute = vi.fn(async (input: unknown) => {
      expect(input).toEqual(command)
      expect(scanDispatchWorkerReceiptCredential("operation-http")).toBe(credential)
      return { delivered: true }
    })
    const server = createServer(
      createSupervisorHandler({ execute } as unknown as SupervisorService, {
        controlToken: control,
        scopedControlToken: scoped,
        admission: "closed",
        persistedCommandReader: read,
      })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const url = `http://127.0.0.1:${address.port}/v1/commands`,
      headers = { authorization: `Bearer ${scoped}`, "content-type": "application/json" }
    try {
      const reply = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationId: "operation-http",
          commandId: "command-http",
          workerCredential: credential,
        }),
      })
      expect(reply.status).toBe(200)
      expect(await reply.json()).toEqual({ delivered: true })
      for (const body of [
        command,
        {
          operationId: "operation-http",
          commandId: "command-http",
          workerCredential: credential,
          command,
        },
      ])
        expect(
          (await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status
        ).toBe(401)
      expect(read).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("requires control authentication and keeps command admission closed by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-http-test-"))
    roots.push(root)
    const journal = new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const service = new SupervisorService({
      journal,
      executor: new NoopExecutor(),
      providerGateway: new NoopGateway(),
      providerGatewayUrl: "http://127.0.0.1:1",
      authorityFence: fixtureAuthorityFence,
      signingSecret: secret,
      supervisorInstanceId: "supervisor-http-1",
      admission: "closed",
      policy: {
        allowedImages: new Set(),
        allowedNetworks: new Set(),
        allowedProcessCommands: new Set(),
        allowedCwdRoots: [tmpdir()],
        allowedCgroupRoot: tmpdir(),
      },
    })
    const scoped = "b".repeat(48),
      workerCredential = "w".repeat(48)
    const consume = vi.fn(async (operationId: string) => {
      expect(scanDispatchWorkerReceiptCredential(operationId)).toBe(workerCredential)
      return { operationId, confirmedSequence: 0, receipts: 0, dispositions: [] }
    })
    const readResult = vi.fn(async (input: unknown) => {
      expect(input).toEqual({ operationId: "operation-http", attemptId: "attempt-http", offset: 0 })
      expect(scanDispatchWorkerReceiptCredential("operation-http")).toBe(workerCredential)
      return { kind: "pending", operationId: "operation-http", attemptId: "attempt-http" }
    })
    const server = createServer(
      createSupervisorHandler(service, {
        controlToken: control,
        scopedControlToken: scoped,
        admission: "closed",
        receiptConsumer: consume,
        nativeResultReader: readResult,
        attemptProofIssuer: async () => ({ scoped: true }),
      })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const base = `http://127.0.0.1:${address.port}`
    try {
      const health = await fetch(`${base}/healthz`)
      expect(await health.json()).toEqual({ status: "ok", admission: "closed" })
      const unauthorized = await fetch(`${base}/v1/commands`, { method: "POST", body: "{}" })
      expect(unauthorized.status).toBe(401)
      const query = new URLSearchParams({
        epochId: "epoch-http",
        supervisorInstanceId: "supervisor-http-1",
        afterSequence: "0",
        afterHash: "0".repeat(64),
        limit: "10",
      })
      expect((await fetch(`${base}/v1/journal?${query}`)).status).toBe(401)
      const brokerHeaders = {
        authorization: `Bearer ${scoped}`,
        "content-type": "application/json",
      }
      expect((await fetch(`${base}/v1/journal?${query}`, { headers: brokerHeaders })).status).toBe(
        401
      )
      expect(
        (await fetch(`${base}/v1/commands`, { method: "POST", headers: brokerHeaders, body: "{}" }))
          .status
      ).toBe(401)
      expect(
        (await fetch(`${base}/v1/recovery`, { method: "POST", headers: brokerHeaders, body: "{}" }))
          .status
      ).toBe(401)
      expect(
        (
          await fetch(`${base}/v1/attempt-proof`, {
            method: "POST",
            headers: brokerHeaders,
            body: "{}",
          })
        ).status
      ).toBe(200)
      const consumed = await fetch(`${base}/v1/consume-receipts`, {
        method: "POST",
        headers: brokerHeaders,
        body: JSON.stringify({ operationId: "operation-http", workerCredential }),
      })
      expect(consumed.status).toBe(200)
      expect(await consumed.json()).toEqual({
        operationId: "operation-http",
        confirmedSequence: 0,
        receipts: 0,
        dispositions: [],
      })
      expect(scanDispatchWorkerReceiptCredential("operation-http")).toBeUndefined()
      const resultBody = {
        operationId: "operation-http",
        attemptId: "attempt-http",
        offset: 0,
        workerCredential,
      }
      const readChunk = (body: unknown, headers = brokerHeaders) =>
        fetch(`${base}/v1/result`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      expect((await readChunk(resultBody)).status).toBe(200)
      expect(
        (
          await readChunk(resultBody, {
            ...brokerHeaders,
            authorization: `Bearer ${workerCredential}`,
          })
        ).status
      ).toBe(401)
      expect((await readChunk({ ...resultBody, path: "/tmp/output" })).status).toBe(400)
      expect((await readChunk({ ...resultBody, offset: -1 })).status).toBe(400)
      expect(readResult).toHaveBeenCalledTimes(1)
      expect(scanDispatchWorkerReceiptCredential("operation-http")).toBeUndefined()
      const malformed = await fetch(`${base}/v1/consume-receipts`, {
        method: "POST",
        headers: brokerHeaders,
        body: JSON.stringify({
          operationId: "operation-http",
          workerCredential,
          workspaceId: "foreign",
        }),
      })
      expect(malformed.status).toBe(400)
      expect(consume).toHaveBeenCalledTimes(1)
      const headers = { authorization: `Bearer ${control}` }
      const localOnly = await fetch(`${base}/v1/journal?${query}`, { headers })
      expect(localOnly.status).toBe(503)
      expect(await localOnly.json()).toMatchObject({ code: "JOURNAL_AUTHORITY_UNAVAILABLE" })
      const read = vi.spyOn(service, "readJournal").mockResolvedValueOnce({
        records: [],
        snapshotHead: null,
        hasMore: false,
        nextCursor: {
          epochId: "epoch-http",
          supervisorInstanceId: "supervisor-http-1",
          afterSequence: 0,
          afterHash: "0".repeat(64),
          limit: 10,
          snapshotSequence: 0,
          snapshotHash: "0".repeat(64),
        },
      })
      const continuation = `${query}&snapshotSequence=0&snapshotHash=${"0".repeat(64)}`
      expect((await fetch(`${base}/v1/journal?${continuation}`, { headers })).status).toBe(200)
      expect(read).toHaveBeenCalledWith({
        epochId: "epoch-http",
        supervisorInstanceId: "supervisor-http-1",
        afterSequence: 0,
        afterHash: "0".repeat(64),
        limit: 10,
        snapshotSequence: 0,
        snapshotHash: "0".repeat(64),
      })
      read.mockRestore()
      for (const malformed of [
        `${query}&limit=1`,
        `${query}&extra=1`,
        `${query}&snapshotSequence=0`,
        `${continuation}&snapshotHash=${"0".repeat(64)}`,
        continuation.replace("snapshotSequence=0", "snapshotSequence=00"),
        continuation.replace("snapshotHash=", "snapshotHash=x"),
        query.toString().replace("afterSequence=0", "afterSequence="),
        query.toString().replace("limit=10", "limit=0"),
      ]) {
        const invalid = await fetch(`${base}/v1/journal?${malformed}`, { headers })
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toMatchObject({ code: "INVALID_CURSOR" })
      }
      const closed = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${control}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "START_UNMETERED",
          commandId: "cmd-http",
          attemptId: "attempt-http",
          executorKey: "scanner",
          expectedReceiptHash: "a".repeat(64),
        }),
      })
      expect(closed.status).toBe(403)
      expect(await closed.json()).toMatchObject({ code: "ADMISSION_CLOSED" })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
