import { createHash, generateKeyPairSync } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { canonicalJson, sha256Hex, signSupervisorAttemptProof } from "@lyrashield/runtime-control"
import {
  createProtectedSupervisorAttemptProofAuthority,
  createProtectedSupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-source"

const originalSigningSecret = "a".repeat(32),
  wrapperSigningSecret = "b".repeat(32)
const { privateKey, publicKey: attemptProofPublicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
})
const options = {
  attemptProofPublicKey,
  connectionString: "postgres://restricted@localhost/disposable",
  streamId: "stream-test",
  authorityEpochId: "epoch-test",
  supervisorInstanceId: "supervisor-test",
  originalSigningSecret,
  wrapperSigningSecret,
  originalKeyHash: createHash("sha256").update(originalSigningSecret).digest("hex"),
  wrapperKeyHash: createHash("sha256").update(wrapperSigningSecret).digest("hex"),
  controlToken: "t".repeat(32),
}
const cursor = {
  epochId: options.authorityEpochId,
  supervisorInstanceId: options.supervisorInstanceId,
  afterSequence: 0,
  afterHash: "0".repeat(64),
  limit: 64,
}

describe("protected supervisor journal source", () => {
  it("allows a bounded late command ACK while preserving the shorter receipt-read deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-command-deadline-")),
      socketPath = join(root, "control.sock")
    let received: (() => void) | undefined, reply: import("node:http").ServerResponse | undefined
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        void _chunk
      }
      reply = response
      received?.()
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const source = createProtectedSupervisorAttemptProofAuthority({
      streamId: options.streamId,
      authorityEpochId: options.authorityEpochId,
      supervisorInstanceId: options.supervisorInstanceId,
      originalKeyHash: options.originalKeyHash,
      wrapperKeyHash: options.wrapperKeyHash,
      attemptProofPublicKey,
      controlToken: options.controlToken,
      transport: { kind: "unix", socketPath },
    })
    const response = {
      commandId: "command-test",
      attemptId: "attempt-test",
      status: "STARTED",
      receipt: {
        sequence: 1,
        hash: "a".repeat(64),
        signature: "b".repeat(64),
        supervisorInstanceId: options.supervisorInstanceId,
        receiptType: "EXECUTOR_STARTED",
        evidenceDigest: "c".repeat(64),
        observedAt: new Date().toISOString(),
      },
    }
    const capture = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error })
      )
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let ready = new Promise<void>((resolve) => {
        received = resolve
      })
      const late = capture(
        source.deliverCommand({ operationId: "operation-test", commandId: "command-test" })
      )
      await ready
      await vi.advanceTimersByTimeAsync(11_000)
      reply!.writeHead(200, { "content-type": "application/json" })
      reply!.end(JSON.stringify(response))
      expect(await late).toEqual({ value: response, error: undefined })
      ready = new Promise<void>((resolve) => {
        received = resolve
      })
      const read = capture(source.consume("operation-test"))
      await ready
      await vi.advanceTimersByTimeAsync(10_001)
      expect((await read).error).toBeInstanceOf(Error)
      ready = new Promise<void>((resolve) => {
        received = resolve
      })
      const stalled = capture(
        source.deliverCommand({ operationId: "operation-test", commandId: "command-test" })
      )
      await ready
      await vi.advanceTimersByTimeAsync(30_001)
      expect((await stalled).error).toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
  it("transports only fixed engine result scope and rejects foreign or malformed chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-result-source-")),
      socketPath = join(root, "control.sock")
    const {
      connectionString: _url,
      originalSigningSecret: _original,
      wrapperSigningSecret: _wrapper,
      ...publicOptions
    } = options
    void [_url, _original, _wrapper]
    const input = { operationId: "operation-test", attemptId: "attempt-test", offset: 0 }
    const workerCredential = "w".repeat(48)
    const response = {
      kind: "available",
      ...input,
      sha256: `sha256:${"a".repeat(64)}`,
      totalBytes: 3,
      base64: "YWJj",
      eof: true,
    }
    let output: unknown = response
    const server = createServer(async (request, reply) => {
      expect(request.url).toBe("/v1/result")
      expect(request.headers.authorization).toBe(`Bearer ${options.controlToken}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ ...input, workerCredential })
      reply.writeHead(200, { "content-type": "application/json" })
      reply.end(JSON.stringify(output))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const source = createProtectedSupervisorAttemptProofAuthority({
        ...publicOptions,
        transport: { kind: "unix", socketPath },
      })
      expect(await source.readResult(input, workerCredential)).toEqual(response)
      for (const changed of [
        { attemptId: "foreign-attempt" },
        { operationId: "foreign-operation" },
        { offset: 1 },
        { base64: "YWJj=" },
        { path: "/tmp/output" },
      ]) {
        output = { ...response, ...changed }
        await expect(source.readResult(input, workerCredential)).rejects.toThrow()
      }
      await expect(
        source.readResult({ ...input, path: "/tmp/output" }, workerCredential)
      ).rejects.toThrow()
      await expect(source.readResult(input, "invalid")).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps broker receipt transport public-only, scoped and bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "scoped-receipt-source-")),
      socketPath = join(root, "control.sock")
    const {
      connectionString: _url,
      originalSigningSecret: _original,
      wrapperSigningSecret: _wrapper,
      ...publicOptions
    } = options
    void [_url, _original, _wrapper]
    let foreign = false,
      privateData = false
    const response = {
      operationId: "operation-test",
      confirmedSequence: 3,
      receipts: 2,
      dispositions: [{ commandId: "command-test", status: "HELD", observedStatus: "REJECTED" }],
    }
    const workerCredential = "w".repeat(48)
    const server = createServer(async (request, reply) => {
      expect(request.url).toBe("/v1/consume-receipts")
      expect(request.headers.authorization).toBe(`Bearer ${options.controlToken}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
        operationId: response.operationId,
        workerCredential,
      })
      reply.writeHead(200, { "content-type": "application/json" })
      reply.end(
        JSON.stringify({
          ...response,
          ...(foreign ? { operationId: "foreign-operation" } : {}),
          ...(privateData ? { journal: ["private"] } : {}),
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const config = { ...publicOptions, transport: { kind: "unix", socketPath } }
      const source = createProtectedSupervisorAttemptProofAuthority(config)
      expect(source).not.toHaveProperty("originalSigningSecret")
      expect(source).not.toHaveProperty("wrapperSigningSecret")
      expect(source).not.toHaveProperty("readJournal")
      expect(source).not.toHaveProperty("connectionString")
      expect(() =>
        createProtectedSupervisorAttemptProofAuthority({ ...config, originalSigningSecret })
      ).toThrow()
      expect(await source.consume(response.operationId, workerCredential)).toEqual(response)
      for (const status of ["STARTED", "STOPPED", "NEVER_DISPATCHED"]) {
        response.dispositions[0]!.status = status
        response.dispositions[0]!.observedStatus = status
        expect(await source.consume(response.operationId, workerCredential)).toEqual(response)
      }
      response.dispositions[0]!.status = "UNREVIEWED_SUCCESS"
      await expect(source.consume(response.operationId, workerCredential)).rejects.toThrow()
      response.dispositions[0]!.status = "STOPPED"
      foreign = true
      await expect(source.consume(response.operationId, workerCredential)).rejects.toThrow()
      foreign = false
      privateData = true
      await expect(source.consume(response.operationId, workerCredential)).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
  it("obtains an authenticated scoped command proof over the private socket and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "attempt-proof-source-")),
      socketPath = join(root, "control.sock")
    const input = {
      operationId: "operation-test",
      attemptId: "attempt-test",
      workspaceId: "workspace-test",
      scanId: "scan-test",
      authorityEpochId: options.authorityEpochId,
      commandId: "command-stop-test",
      type: "STOP" as const,
      challenge: "a".repeat(64),
    }
    const command = {
      type: "STOP" as const,
      commandId: input.commandId,
      attemptId: input.attemptId,
      expectedReceiptHash: "b".repeat(64),
    }
    const now = new Date()
    const proof = signSupervisorAttemptProof(
      {
        purpose: "lyrashield-supervisor-attempt-proof/2",
        input,
        binding: {
          operationId: input.operationId,
          attemptId: input.attemptId,
          workspaceId: input.workspaceId,
          scanId: input.scanId,
          authorityEpochId: input.authorityEpochId,
          authorityRevision: 1,
          workerIdentity: "worker-test",
          billingMode: "UNMETERED",
          expiresAt: now.toISOString(),
        },
        supervisorInstanceId: options.supervisorInstanceId,
        prepareChecksum: "c".repeat(64),
        preparedCompleted: false,
        status: "UNKNOWN",
        command,
        commandChecksum: sha256Hex(canonicalJson(command)),
        headInputChecksum: "d".repeat(64),
        headSequence: 1,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10_000).toISOString(),
      },
      { privateKey }
    )
    let tamper = false
    const server = createServer(async (request, response) => {
      expect(request.method).toBe("POST")
      expect(request.url).toBe("/v1/attempt-proof")
      expect(request.headers.authorization).toBe(`Bearer ${options.controlToken}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(input)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(tamper ? { ...proof, headSequence: 2 } : proof))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const source = createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "unix", socketPath },
      })
      expect(await source.readAttemptProof!(input)).toEqual(proof)
      tamper = true
      await expect(source.readAttemptProof!(input)).rejects.toThrow(
        "Attempt proof authority is unavailable"
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads the private socket with exact scope and authenticated fixed-head continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipt-source-")),
      socketPath = join(root, "control.sock")
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${options.controlToken}`)
      const url = new URL(request.url!, "http://local")
      expect(url.pathname).toBe("/v1/journal")
      expect(url.searchParams.get("snapshotSequence")).toBe("12")
      expect(url.searchParams.get("snapshotHash")).toBe("f".repeat(64))
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"signed":"page"}')
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const source = createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "unix", socketPath },
      })
      expect(
        await source.readJournal({ ...cursor, snapshotSequence: 12, snapshotHash: "f".repeat(64) })
      ).toEqual({ signed: "page" })
      expect(() => source.readJournal({ ...cursor, epochId: "foreign" })).toThrow(
        "Supervisor receipt authority"
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
  it("rejects caller-selected remote endpoints and key mismatch before I/O", () => {
    expect(() =>
      createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "url", url: "https://example.com" },
      })
    ).toThrow()
    expect(() =>
      createProtectedSupervisorReceiptAuthority({
        ...options,
        originalKeyHash: "0".repeat(64),
        transport: { kind: "unix", socketPath: "/unused" },
      })
    ).toThrow()
  })
  it("does not follow redirects or accept unsigned error response bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: "https://example.com",
        "content-type": "application/json",
      })
      response.end('{"secret":"private"}')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("listener unavailable")
      const source = createProtectedSupervisorReceiptAuthority({
        ...options,
        transport: { kind: "loopback", port: address.port },
      })
      await expect(source.readJournal(cursor)).rejects.toThrow("SUPERVISOR_SOURCE_READ_UNAVAILABLE")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
